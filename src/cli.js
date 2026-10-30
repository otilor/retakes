import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectProject, EFFORTS, isModelName } from './project.js';
import { Retakes } from './retakes.js';
import { Hub } from './hub.js';
import { UserError, findPort, portFree } from './proc.js';
import * as G from './git.js';
import { License, PRO_URL } from './license.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const DOCK_FILE = path.join(here, '..', 'dist', 'dock.js');

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const blue = c('38;5;111');
const red = c('31');

const HELP = `${bold('retakes')} ${dim(pkg.version)}  Ask Claude Code for changes to your running app and flip between takes.

${bold('Usage')}
  retakes                 Start your dev server with the dock (run it in your app's folder)
  retakes clean           Remove every take: its worktree, its branch and its saved state
  retakes activate <key>  Turn on Retakes Pro on this machine
  retakes license         Show whether Pro is on
  retakes deactivate      Turn Pro off here and free the key for another machine

${bold('Options')}
  --port <n>           Port to open the app on (default 4300)
  --host <host>        Address to listen on (default 127.0.0.1)
  --model <name>       Model for new runs: haiku, sonnet (default), opus or a full model id
  --effort <level>     Effort for new runs: ${EFFORTS.join(', ')} (default low)
  --no-open            Don't open the browser
  --yes                With clean: don't ask first
  -h, --help           Show this help
  -v, --version        Show the version

${bold('Config')} (optional, retakes.config.json in your app's folder)
  {
    "port": 4300,
    "dev": "npm run dev -- --port {port}",   ${dim('// only for dev servers other than Vite and Next.js')}
    "setup": "npm ci",                       ${dim('// runs in each new take')}
    "copy": [".env.local"],                  ${dim('// files copied into each take (default: .env*)')}
    "agent": { "model": "haiku", "effort": "medium" }  ${dim('// sonnet on low effort by default')}
  }

  You can also switch the model and effort from the dock, in the New take panel.
  The pick is remembered for the app; --model and --effort replace it at start.
`;

export function parseArgs(argv) {
  const out = { cmd: 'start', open: true, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i];
      if (v === undefined || v === '') throw new UserError(`${a.split('=')[0]} needs a value.`);
      return v;
    };
    if (a === '-h' || a === '--help') out.cmd = 'help';
    else if (a === '-v' || a === '--version') out.cmd = 'version';
    else if (a === '--no-open') out.open = false;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const p = Number(val());
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new UserError('--port needs a port number.');
      out.port = p;
    } else if (a === '--host' || a.startsWith('--host=')) out.host = val();
    else if (a === '--model' || a.startsWith('--model=')) {
      const m = val();
      if (!isModelName(m)) throw new UserError('--model needs a model name, like sonnet, haiku or opus.');
      out.model = m;
    } else if (a === '--effort' || a.startsWith('--effort=')) {
      const e = val();
      if (!EFFORTS.includes(e)) throw new UserError(`--effort is one of ${EFFORTS.join(', ')}.`);
      out.effort = e;
    }
    else if (a === 'start' || a === 'clean' || a === 'deactivate' || a === 'license') out.cmd = a;
    else if (a === 'activate') {
      out.cmd = 'activate';
      out.key = argv[++i];
      if (!out.key || out.key.startsWith('-')) throw new UserError('Paste your license key: retakes activate <key>');
    }
    else throw new UserError(`Unknown option: ${a}. Run retakes --help.`);
  }
  return out;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.cmd === 'help') return void process.stdout.write(HELP);
    if (opts.cmd === 'version') return void console.log(pkg.version);
    if (opts.cmd === 'clean') return await clean(opts);
    if (opts.cmd === 'activate' || opts.cmd === 'deactivate' || opts.cmd === 'license') return await licenseCmd(opts);
    return await start(opts);
  } catch (err) {
    if (err instanceof UserError) {
      console.error(red('✖ ') + err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function log(msg, detail) {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`${dim(time)}  ${msg}`);
  if (detail) {
    const lines = String(detail).trim().split('\n').slice(-15);
    for (const l of lines) console.log(dim(`          │ ${l}`));
  }
}

function lockFile(project) {
  return path.join(project.stateDir, 'retakes.pid');
}

function runningPid(project) {
  try {
    const pid = Number(fs.readFileSync(lockFile(project), 'utf8'));
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function start(opts) {
  if (!fs.existsSync(DOCK_FILE)) throw new UserError('The dock bundle is missing. Run `npm run build` in the retakes package.');
  const project = await detectProject(process.cwd());
  fs.mkdirSync(project.stateDir, { recursive: true });
  const other = runningPid(project);
  if (other) throw new UserError(`retakes is already running for this app (process ${other}). Stop it first.`);

  const host = opts.host || '127.0.0.1';
  let port = opts.port || project.config.port;
  if (port) {
    if (!(await portFree(port))) throw new UserError(`Port ${port} is already in use. Pick another with --port.`);
  } else {
    port = await findPort(4300);
  }
  fs.writeFileSync(lockFile(project), String(process.pid));

  console.log(`\n${bold('Retakes')} ${dim(pkg.version)}  ${project.name}`);
  if (project.devMode.note === 'ignoring-script') {
    const tool = project.devMode.kind === 'next' ? 'next dev' : 'vite';
    console.log(dim(`Your "dev" script doesn't start with ${tool}, so Retakes runs ${tool} directly. Set "dev" in retakes.config.json if it needs more.`));
  }
  const license = new License();
  if (license.data) {
    license.refresh().catch(() => {});
    setInterval(() => license.refresh().catch(() => {}), 6 * 60 * 60 * 1000).unref();
  }
  const retakes = new Retakes(project, { log, license, agent: { model: opts.model, effort: opts.effort } });
  const hub = new Hub(retakes, { port, host, dockFile: DOCK_FILE, log });
  await hub.listen();
  const shownHost = host === '127.0.0.1' || host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${shownHost}:${port}`;

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) {
      process.exit(code || 1);
    }
    stopping = true;
    console.log(dim('\nStopping dev servers and agents…'));
    const force = setTimeout(() => process.exit(code), 8000);
    force.unref();
    await hub.close().catch(() => {});
    await retakes.shutdown().catch(() => {});
    try {
      if (Number(fs.readFileSync(lockFile(project), 'utf8')) === process.pid) fs.unlinkSync(lockFile(project));
    } catch {
      /* already gone */
    }
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGHUP', () => stop(0));
  process.on('uncaughtException', (err) => {
    console.error(red('Retakes crashed: ') + (err.stack || err.message));
    stop(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error(red('Retakes hit an unexpected error: ') + ((err && err.stack) || err));
  });

  log('main: starting your dev server');
  const ready = retakes.start();
  console.log(`\n  ${blue('➜')}  ${bold(url)}\n  ${dim('Press . on the page to show or hide the dock. Ctrl+C to stop.')}\n`);
  if (opts.open) openBrowser(url);
  await ready;
}

async function clean(opts) {
  const project = await detectProject(process.cwd());
  const other = runningPid(project);
  if (other) throw new UserError(`retakes is running for this app (process ${other}). Stop it before cleaning.`);
  const roots = [project.takesDir];
  if (fs.existsSync(project.takesDir)) roots.push(fs.realpathSync(project.takesDir));
  const worktrees = (await G.listWorktrees(project.gitRoot)).filter((w) =>
    roots.some((r) => path.resolve(w.dir).startsWith(r + path.sep))
  );
  const branches = (await G.git(['branch', '--list', 'retakes/take-*', '--format=%(refname:short)'], project.gitRoot))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!worktrees.length && !branches.length && !fs.existsSync(project.stateDir)) {
    console.log('Nothing to clean.');
    return;
  }
  console.log(`This removes ${worktrees.length} take folder${worktrees.length === 1 ? '' : 's'} and ${branches.length} branch${branches.length === 1 ? '' : 'es'} (${branches.join(', ') || 'none'}).`);
  console.log(dim('Work you kept is already merged and stays. Anything else in those takes is deleted.'));
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new UserError('Run `retakes clean --yes` to confirm.');
    const ok = await ask('Remove them? (y/N) ');
    if (!/^y(es)?$/i.test(ok.trim())) {
      console.log('Nothing removed.');
      return;
    }
  }
  for (const w of worktrees) await G.removeWorktree(project.gitRoot, w.dir, null);
  for (const b of branches) await G.git(['branch', '-D', b], project.gitRoot).catch(() => {});
  await G.git(['worktree', 'prune'], project.gitRoot).catch(() => {});
  fs.rmSync(project.stateDir, { recursive: true, force: true });
  console.log('Cleaned.');
}

async function licenseCmd(opts) {
  const license = new License();
  if (opts.cmd === 'activate') {
    const info = await license.activate(opts.key);
    console.log(`${blue('✔')} Retakes Pro is on for this machine (${info.key}). Thanks for supporting Retakes.`);
    if (info.expiresAt) console.log(dim(`  Renews or ends on ${info.expiresAt.slice(0, 10)}.`));
    return;
  }
  if (opts.cmd === 'deactivate') {
    console.log((await license.deactivate()) ? 'Pro is off on this machine, and the key is free to use on another one.' : 'No license on this machine.');
    return;
  }
  const info = await license.refresh({ force: true });
  if (info.active) console.log(`${blue('✔')} Retakes Pro is on (${info.key}).`);
  else if (info.key) {
    const expired = info.expiresAt && Date.parse(info.expiresAt) <= Date.now();
    const why = expired ? 'expired' : info.status === 'granted' ? 'not confirmed in the last week' : info.status;
    console.log(`Retakes Pro is off: the key ${info.key} is ${why}. Run \`retakes license\` online, or get a new key at ${PRO_URL}`);
  } else console.log(`Retakes Pro isn't on here. Get a key at ${PRO_URL}, then run \`retakes activate <key>\`.`);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => (rl.close(), resolve(a))));
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser to open, the URL is printed */
  }
}
