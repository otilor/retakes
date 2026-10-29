import { spawn, execFile } from 'node:child_process';
import net from 'node:net';

const isWin = process.platform === 'win32';

export class UserError extends Error {}

/** Run a command and resolve with stdout. Rejects with stderr in the message. */
export function run(cmd, args, { cwd, env, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').trim() || String(stdout || '').trim() || err.message;
        const e = new Error(msg);
        e.code = err.code;
        e.stdout = String(stdout || '');
        e.stderr = String(stderr || '');
        reject(e);
      } else resolve(String(stdout));
    });
  });
}

/**
 * Spawn a long-running process in its own process group, so killTree() can stop
 * everything it started (npm -> vite, and so on).
 */
export function spawnGroup(cmd, args, { cwd, env, shell = false, stdin = 'ignore' } = {}) {
  return spawn(cmd, args, {
    cwd,
    env,
    shell,
    detached: !isWin,
    windowsHide: true,
    stdio: [stdin, 'pipe', 'pipe'],
  });
}

export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Stop a process group: SIGTERM, then SIGKILL if it hasn't exited after `graceMs`. */
export function stopTree(child, graceMs = 3000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolve(); }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    killTree(child, 'SIGTERM');
  });
}

/** Resolve true if something accepts TCP connections on host:port. */
export function canConnect(port, host, timeout = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Resolve true if nothing is listening on the port on any local interface. */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      srv.close(async () => {
        // Something bound only to ::1 or 127.0.0.1 would not block 0.0.0.0 on every OS.
        const busy = (await canConnect(port, '127.0.0.1', 300)) || (await canConnect(port, '::1', 300));
        resolve(!busy);
      });
    });
  });
}

const handedOut = new Set();

/** Find a free port at or above `start`, never handing out the same one twice in this process. */
export async function findPort(start, { max = 200 } = {}) {
  for (let p = start; p < start + max; p++) {
    if (handedOut.has(p)) continue;
    // Reserve before the async check so two callers at once never get the same port.
    handedOut.add(p);
    if (await portFree(p)) return p;
    handedOut.delete(p);
  }
  throw new UserError(`No free port found between ${start} and ${start + max - 1}.`);
}

export function releasePort(port) {
  handedOut.delete(port);
}

/** Keep the last `max` lines of a stream of text. */
export class Tail {
  constructor(max = 200) {
    this.max = max;
    this.lines = [];
    this.partial = '';
  }
  push(chunk) {
    const text = this.partial + String(chunk);
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop();
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }
  text(n = this.max) {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-n).join('\n');
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}
