'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const files = [];

function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name)) collect(file);
    } else if (entry.isFile() && /\.(?:js|cjs)$/i.test(entry.name)) {
      files.push(file);
    }
  }
}

for (const directory of ['app', 'scripts', 'tests']) {
  collect(path.join(projectRoot, directory));
}
files.sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    failed += 1;
    console.error(`Syntax check failed: ${path.relative(projectRoot, file)}`);
    console.error(result.error?.message || result.stderr || result.stdout || `Exit ${result.status}`);
  }
}
if (failed) {
  console.error(`${failed} of ${files.length} JavaScript files failed syntax checks.`);
  process.exitCode = 1;
} else {
  console.log(`Syntax checks passed: ${files.length} JavaScript files in app/, scripts/, and tests/.`);
}
