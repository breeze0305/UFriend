'use strict';

const { prepareFfmpegRuntime } = require('./ffmpeg-runtime.cjs');

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--from')) {
    throw new Error('Usage: node scripts/prepare-ffmpeg.cjs --from <extracted UFriend bundled FFmpeg package>');
  }
  const runtime = prepareFfmpegRuntime(args[1]);
  console.log(`FFmpeg ready: ${runtime.executable}`);
  console.log(`${runtime.version}; ${runtime.license}; verified ASS, subtitles, libx264, AAC and MP3.`);
} catch (error) {
  console.error('FFmpeg preparation failed: ' + error.message);
  process.exitCode = 1;
}
