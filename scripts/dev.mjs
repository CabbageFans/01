import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';
const preferredPort = 5173;
/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();
let shuttingDown = false;

/** @param {number} port @returns {Promise<boolean>} */
function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** @param {number} startPort @returns {Promise<number>} */
async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available development port found from ${startPort} to ${startPort + 99}`);
}

/** @param {string} command @param {string[]} args @param {import('node:child_process').SpawnOptions} options @returns {import('node:child_process').ChildProcess} */
function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', (error) => {
    children.delete(child);
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
    stopChildren();
  });
  return child;
}

/** @param {import('node:child_process').ChildProcess} child @param {string} label @returns {Promise<void>} */
function waitForExit(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${signal || `code ${code}`}`));
    });
  });
}

/** @param {string} url @param {import('node:child_process').ChildProcess} viteProcess @param {number} timeoutMs @returns {Promise<void>} */
async function waitForServer(url, viteProcess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown || viteProcess.exitCode !== null || viteProcess.signalCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${viteProcess.exitCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** @returns {void} */
function stopChildren() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      // 只清理本轮持有的子进程；超时后升级信号，不按进程名称批量终止。
      const timer = setTimeout(() => {
        if (children.has(child)) child.kill('SIGKILL');
      }, 5000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
}

/** @returns {Promise<void>} */
async function main() {
  const electronArgs = process.argv.slice(2);
  // Mac 开发启动总是显式选择独立 profile；直接调用 Electron 的默认路径保持不变。
  if (process.platform === 'darwin' && !electronArgs.some((arg) => arg.startsWith('--profile='))) {
    electronArgs.push('--profile=mac-dev');
  }
  const port = await findAvailablePort(preferredPort);
  const devServerUrl = `http://${host}:${port}`;
  if (port !== preferredPort) {
    console.log(`[dev] Port ${preferredPort} is occupied; using ${port} instead.`);
  }

  const tscBin = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  await waitForExit(run(process.execPath, [tscBin, '-p', 'packages/contracts/tsconfig.json']), 'Contracts build');
  if (shuttingDown) return;
  await waitForExit(run(process.execPath, [tscBin, '-p', 'tsconfig.main.json']), 'Main-process build');
  if (shuttingDown) return;

  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteProcess = run(process.execPath, [viteBin, '--host', host, '--port', String(port), '--strictPort']);
  viteProcess.once('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[dev] Vite exited (code ${code}); stopping this development session.`);
    process.exitCode = code || 1;
    stopChildren();
  });
  await waitForServer(devServerUrl, viteProcess);
  if (shuttingDown) return;

  const electronPath = require('electron');
  const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
  // 编辑器可能设置此变量；仅从 GUI 子进程副本移除，不更改父进程环境。
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronProcess = run(electronPath, ['.', ...electronArgs], {
    env: electronEnv,
  });
  console.log(`[dev] launcher=${process.pid} vite=${viteProcess.pid} electron=${electronProcess.pid}`);

  electronProcess.once('exit', (code, signal) => {
    if (shuttingDown) return;
    if (signal) console.error(`[dev] Electron exited with ${signal}.`);
    stopChildren();
    process.exitCode = code ?? 1;
  });
}

process.once('SIGINT', () => {
  process.exitCode = 130;
  stopChildren();
});
process.once('SIGTERM', () => {
  process.exitCode = 143;
  stopChildren();
});
process.once('exit', stopChildren);

main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  stopChildren();
  process.exitCode = 1;
});
