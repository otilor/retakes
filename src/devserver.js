import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnGroup, stopTree, canConnect, findPort, releasePort, Tail, stripAnsi } from './proc.js';
import { findBin } from './project.js';

const READY_TIMEOUT_MS = 120_000;

/**
 * One dev server for one version of the app (main or a take).
 * status: stopped | starting | ready | failed | crashed
 */
export class DevServer extends EventEmitter {
  constructor({ project, appDir, stopAt, logFile }) {
    super();
    this.project = project;
    this.appDir = appDir;
    this.stopAt = stopAt;
    this.logFile = logFile;
    this.status = 'stopped';
    this.port = null;
    this.host = '127.0.0.1';
    this.error = null;
    this.child = null;
    this.tail = new Tail(300);
    this.stopping = false;
  }

  info() {
    return { status: this.status, port: this.port, error: this.error };
  }

  set(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('change', this.info());
  }

  async start({ attempt = 1 } = {}) {
    if (this.status === 'starting' || this.status === 'ready') return;
    this.stopping = false;
    this.port = await findPort(5180);
    const spec = this.spawnSpec();
    if (spec.error) {
      this.set('failed', spec.error);
      return;
    }
    const log = this.logFile ? fs.createWriteStream(this.logFile, { flags: 'a' }) : null;
    log?.write(`\n--- dev server: ${spec.cmd} ${spec.args.join(' ')} (port ${this.port})\n`);
    const child = spawnGroup(spec.cmd, spec.args, { cwd: this.appDir, env: spec.env, shell: spec.shell });
    this.child = child;
    this.set('starting');
    const onData = (d) => {
      this.tail.push(stripAnsi(d));
      log?.write(d);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      onData(`\n${err.message}\n`);
    });
    child.on('exit', (code, signal) => {
      log?.end(`\n--- dev server exited (${signal || code})\n`);
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.set('stopped');
        return;
      }
      const output = this.tail.text(30);
      if (this.status === 'starting') {
        if (attempt < 3 && /already in use|EADDRINUSE/i.test(output)) {
          this.status = 'stopped';
          this.start({ attempt: attempt + 1 });
          return;
        }
        this.set('failed', output || `The dev server exited with code ${code}.`);
      } else {
        this.set('crashed', output || `The dev server stopped (${signal || code}).`);
      }
    });

    const started = Date.now();
    const hosts = spec.hosts;
    while (this.child === child && this.status === 'starting') {
      for (const h of hosts) {
        if (await canConnect(this.port, h)) {
          if (this.child === child && this.status === 'starting') {
            this.host = h;
            this.set('ready');
          }
          return;
        }
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        this.set('failed', `The dev server didn't open port ${this.port} within ${READY_TIMEOUT_MS / 1000} seconds.\n${this.tail.text(20)}`);
        await stopTree(child);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  spawnSpec() {
    const env = { ...process.env, BROWSER: 'none', PORT: String(this.port), NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    const mode = this.project.devMode;
    if (mode.kind === 'command') {
      return {
        cmd: mode.command.replaceAll('{port}', String(this.port)),
        args: [],
        shell: true,
        env,
        hosts: ['127.0.0.1', '::1'],
      };
    }
    const name = mode.kind === 'next' ? 'next' : 'vite';
    const bin = findBin(this.appDir, this.stopAt, name);
    if (!bin) {
      const label = name === 'next' ? 'Next.js' : 'Vite';
      return {
        error: `${label} isn't installed in ${this.appDir}. Run \`${this.project.pm.name} install\` there first.`,
      };
    }
    if (name === 'next') {
      return {
        cmd: process.execPath,
        args: [bin, 'dev', ...mode.args, '--port', String(this.port), '--hostname', '127.0.0.1'],
        shell: false,
        env: { ...env, NEXT_TELEMETRY_DISABLED: '1' },
        hosts: ['127.0.0.1'],
      };
    }
    return {
      cmd: process.execPath,
      args: [bin, ...mode.args, '--port', String(this.port), '--strictPort', '--host', '127.0.0.1'],
      shell: false,
      env,
      hosts: ['127.0.0.1'],
    };
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (child) await stopTree(child);
    if (this.port) releasePort(this.port);
    if (this.status !== 'stopped') this.set('stopped');
  }

  async restart() {
    await this.stop();
    await this.start();
  }
}
