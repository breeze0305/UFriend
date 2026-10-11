'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const messages = {
  MEDIA_SETUP_UNAVAILABLE: '此版本沒有影音元件安裝器，請查看安裝說明。',
  MEDIA_SETUP_BUSY: '影音元件正在安裝，請稍候。',
  MEDIA_SETUP_EXTRACTOR: '找不到 7-Zip。請先安裝 7-Zip，或選擇已解壓的官方 FFmpeg 套件。',
  MEDIA_SETUP_FAILED: '影音元件安裝失敗。請使用已解壓的官方套件重試，或查看安裝說明。',
  MEDIA_SETUP_CANCELLED: '影音元件安裝已取消。',
  MEDIA_SETUP_SHUTDOWN: '影音元件安裝尚未停止，請稍後再試。',
};
function failure(code) { return Object.assign(new Error(messages[code]), { code }); }

// Installation is an explicit user action. Temporary portable resources are
// only the source; the runtime lives beside the persistent workspace data.
class MediaRuntimeSetup {
  constructor({ resourcesPath, userDataPath, isPackaged, resolveFfmpeg, onChange = () => {}, spawnProcess = spawn }) {
    if (!path.isAbsolute(userDataPath)) throw new Error('Media setup requires an absolute user data directory.');
    this.destinationRoot = path.join(userDataPath, 'media-runtime');
    this.installer = resourcesPath && path.join(resourcesPath, 'media-runtime-setup', 'install-media-runtime.ps1');
    this.supported = Boolean(isPackaged && this.installer && fs.existsSync(this.installer));
    this.bundledExecutable = isPackaged && resourcesPath ? path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe') : null;
    this.resolveFfmpeg = resolveFfmpeg;
    this.onChange = onChange;
    this.spawnProcess = spawnProcess;
    this.active = null;
    this.error = '';
  }

  snapshot() {
    const executable = this.resolveFfmpeg(), installed = fs.existsSync(executable);
    const bundled = Boolean(installed && this.bundledExecutable && path.resolve(executable).toLowerCase() === path.resolve(this.bundledExecutable).toLowerCase());
    return { available: this.supported, installed, bundled, installing: Boolean(this.active), error: this.error };
  }

  async install({ from } = {}) {
    if (this.active) throw failure('MEDIA_SETUP_BUSY');
    if (!this.supported) throw failure('MEDIA_SETUP_UNAVAILABLE');
    if (from !== undefined && (typeof from !== 'string' || !path.isAbsolute(from))) throw failure('MEDIA_SETUP_FAILED');
    this.error = '';
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.installer, '-DestinationRoot', this.destinationRoot];
    if (from) args.push('-From', from);
    const child = this.spawnProcess('powershell.exe', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const task = { child, cancelled: false, closed: false, output: '' };
    this.active = task;
    task.closedPromise = new Promise(resolve => {
      const collect = chunk => { task.output = (task.output + chunk.toString()).slice(-16384); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', () => { task.closed = true; resolve({ code: null }); });
      child.once('close', code => { task.closed = true; resolve({ code }); });
    });
    this.onChange();
    try {
      const result = await task.closedPromise;
      if (task.cancelled) throw failure('MEDIA_SETUP_CANCELLED');
      if (result.code !== 0 || !this.snapshot().installed) {
        throw failure(/7-Zip is required|7-Zip was not found/.test(task.output) ? 'MEDIA_SETUP_EXTRACTOR' : 'MEDIA_SETUP_FAILED');
      }
      return { installed: true };
    } catch (error) {
      this.error = error.message;
      throw error;
    } finally {
      if (this.active === task) this.active = null;
      this.onChange();
    }
  }

  async shutdown() {
    const task = this.active;
    if (!task || task.closed) return;
    task.cancelled = true;
    if (!Number.isSafeInteger(task.child.pid) || task.child.pid <= 0) {
      if (!task.closed) throw failure('MEDIA_SETUP_SHUTDOWN');
      return;
    }
    // Stop only this installer and its own extraction child. Never match by name.
    const stopped = await new Promise(resolve => {
      const killer = this.spawnProcess('taskkill.exe', ['/PID', String(task.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', () => resolve(false));
      killer.once('close', code => resolve(code === 0));
    });
    if (!stopped && !task.closed) throw failure('MEDIA_SETUP_SHUTDOWN');
    await task.closedPromise;
  }
}

module.exports = { MediaRuntimeSetup };
