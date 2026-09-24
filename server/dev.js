const { fork, spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const frontendPort = process.env.FRONTEND_PORT || '4200';
const children = [];
let stopping = false;

function start(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  children.push(child);
  return child;
}

const api = fork(path.join(__dirname, 'index.js'), [], {
  cwd: root,
  env: process.env,
  silent: false
});
children.push(api);
const frontend = start(npmCommand, [
  'ng',
  'serve',
  '--proxy-config',
  'proxy.conf.json',
  '--port',
  frontendPort
]);

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 200);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

api.on('exit', (code) => {
  if (!stopping) stop(code || 1);
});

frontend.on('exit', (code) => {
  if (!stopping) stop(code || 1);
});
