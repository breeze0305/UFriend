'use strict';
const path = require('node:path');

function portableExecutable(env = process.env) {
  const file = env.PORTABLE_EXECUTABLE_FILE;
  if (!file) return null;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.exe') {
    throw new Error('The portable executable path is invalid.');
  }
  return file;
}

function relaunchOptions({ env = process.env, argv = process.argv } = {}) {
  const executable = portableExecutable(env);
  return executable ? { execPath: executable, args: argv.slice(1) } : undefined;
}

module.exports = { portableExecutable, relaunchOptions };
