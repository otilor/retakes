import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { git } from './git.js';
import { UserError } from './proc.js';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const CONFIG_FILE = 'orch.config.json';

export async function detectProject(cwd) {
  const dir = path.resolve(cwd);
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new UserError(`There's no package.json in ${dir}. Run orch in your app's folder.`);
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    throw new UserError(`Couldn't read package.json: ${err.message}`);
  }

  let gitRoot;
  try {
    gitRoot = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
  } catch {
    throw new UserError(
      "This folder isn't in a git repository. Orchestrator keeps every take on its own branch, so run `git init` and make a first commit, then try again."
    );
  }
  try {
    await git(['rev-parse', '--verify', 'HEAD'], dir);
  } catch {
    throw new UserError('Your repository has no commits yet. Make a first commit, then run orch again.');
  }

  gitRoot = fs.realpathSync(gitRoot);
  const appDir = fs.realpathSync(dir);
  const rel = path.relative(gitRoot, appDir);
  const config = loadConfig(appDir);
  const pm = detectPackageManager(appDir, gitRoot);
  const devMode = resolveDevMode(pkg, config);
  const id = `${slug(pkg.name || path.basename(appDir))}-${hash(appDir).slice(0, 8)}`;
  const home = process.env.ORCH_HOME ? path.resolve(process.env.ORCH_HOME) : path.join(os.homedir(), '.orch');
  const stateDir = path.join(home, 'projects', id);

  return {
    name: pkg.name || path.basename(appDir),
    appDir,
    gitRoot,
    rel,
    pkg,
    config,
    pm,
    devMode,
    stateDir,
    takesDir: path.join(stateDir, 'takes'),
  };
}

export function loadConfig(appDir) {
  const file = path.join(appDir, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UserError(`${CONFIG_FILE} isn't valid JSON: ${err.message}`);
  }
  const out = {};
  const bad = (key, want) => {
    throw new UserError(`In ${CONFIG_FILE}, "${key}" should be ${want}.`);
  };
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) bad('port', 'a port number');
    out.port = raw.port;
  }
  if (raw.dev !== undefined) {
    if (typeof raw.dev !== 'string' || !raw.dev.includes('{port}')) bad('dev', 'a command that includes {port}, like "npm run dev -- --port {port}"');
    out.dev = raw.dev;
  }
  if (raw.setup !== undefined) {
    if (typeof raw.setup !== 'string') bad('setup', 'a command, like "npm ci"');
    out.setup = raw.setup;
  }
  if (raw.copy !== undefined) {
    if (!Array.isArray(raw.copy) || raw.copy.some((p) => typeof p !== 'string' || path.isAbsolute(p) || p.includes('..'))) {
      bad('copy', 'a list of file paths inside your app folder, like [".env.local"]');
    }
    out.copy = raw.copy;
  }
  if (raw.agent !== undefined) {
    const a = raw.agent;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) bad('agent', 'an object');
    if (a.command !== undefined && typeof a.command !== 'string') bad('agent.command', 'a command, like "claude"');
    if (a.args !== undefined && (!Array.isArray(a.args) || a.args.some((x) => typeof x !== 'string'))) bad('agent.args', 'a list of strings');
    if (a.permissionMode !== undefined && typeof a.permissionMode !== 'string') bad('agent.permissionMode', 'a string');
    if (a.model !== undefined && (typeof a.model !== 'string' || !a.model.trim())) bad('agent.model', 'a model name, like "sonnet", "haiku" or "opus"');
    if (a.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(a.effort)) bad('agent.effort', 'one of "low", "medium", "high", "xhigh" or "max"');
    out.agent = { command: a.command, args: a.args, permissionMode: a.permissionMode, model: a.model, effort: a.effort };
  }
  return out;
}

export function detectPackageManager(appDir, gitRoot) {
  let d = appDir;
  for (;;) {
    for (const [file, name] of LOCKFILES) {
      if (fs.existsSync(path.join(d, file))) return { name, lockfile: file, root: d };
    }
    if (d === gitRoot) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { name: 'npm', lockfile: null, root: appDir };
}

export function installCommand(pm) {
  switch (pm.name) {
    case 'pnpm':
      return ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']];
    case 'yarn':
      return ['yarn', ['install']];
    case 'bun':
      return ['bun', ['install']];
    default:
      return pm.lockfile
        ? ['npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline']]
        : ['npm', ['install', '--no-audit', '--no-fund']];
  }
}

/**
 * How to start a dev server on a given port. Vite and Next.js apps need no config: we run them
 * ourselves with the arguments from the "dev" script. Anything else needs "dev" in
 * orch.config.json.
 */
export function resolveDevMode(pkg, config) {
  if (config.dev) return { kind: 'command', command: config.dev };
  const script = pkg.scripts && pkg.scripts.dev;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (script && /^\s*next\s+dev(\s|$)/.test(script)) {
    return { kind: 'next', args: nextArgsFromScript(script) };
  }
  if (script && /^\s*vite(\s|$)/.test(script)) {
    return { kind: 'vite', args: viteArgsFromScript(script) };
  }
  if (deps.next) return { kind: 'next', args: [], note: script ? 'ignoring-script' : null };
  if (deps.vite) return { kind: 'vite', args: [], note: script ? 'ignoring-script' : null };
  throw new UserError(
    'Orchestrator runs Vite and Next.js apps out of the box. For another dev server, add "dev" to orch.config.json with a {port} placeholder, like:\n  { "dev": "npm run dev -- --port {port}" }'
  );
}

/** Split a "next dev ..." npm script into arguments after "dev", dropping the port and hostname. */
export function nextArgsFromScript(script) {
  const tokens = splitArgs(script.trim()).slice(2);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = t.split('=')[0];
    if (['--port', '-p', '--hostname', '-H'].includes(name)) {
      if (!t.includes('=') && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Split a "vite ..." npm script into arguments, dropping the ones Orchestrator sets itself. */
export function viteArgsFromScript(script) {
  const tokens = splitArgs(script.trim()).slice(1);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = t.split('=')[0];
    if (['--port', '--host', '--open', '-p'].includes(name)) {
      if (!t.includes('=') && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }
    if (name === '--strictPort' || name === '--strict-port') continue;
    out.push(t);
  }
  return out;
}

export function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Find a package's CLI entry (vite, next), walking up from the app folder like Node's resolver does. */
export function findBin(appDir, stopAt, name = 'vite') {
  let d = appDir;
  for (;;) {
    const pkgFile = path.join(d, 'node_modules', name, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const vpkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        const bin = typeof vpkg.bin === 'string' ? vpkg.bin : vpkg.bin && vpkg.bin[name];
        if (bin) return path.join(d, 'node_modules', name, bin);
      } catch {
        /* keep looking */
      }
    }
    if (stopAt && d === stopAt) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** The files copied into every new take: .env files by default, since git doesn't track them. */
export function filesToCopy(appDir, config) {
  if (config.copy) return config.copy.filter((p) => fs.existsSync(path.join(appDir, p)));
  return fs
    .readdirSync(appDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\.env(\..+)?$/.test(e.name))
    .map((e) => e.name);
}

export function slug(s) {
  return String(s).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

export function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
