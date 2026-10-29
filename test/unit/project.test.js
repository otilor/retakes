import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  detectPackageManager,
  installCommand,
  resolveDevMode,
  viteArgsFromScript,
  nextArgsFromScript,
  splitArgs,
  filesToCopy,
  slug,
} from '../../src/project.js';
import { UserError } from '../../src/proc.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-unit-'));
const write = (dir, rel, text = '') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test('splitArgs handles quotes and repeated spaces', () => {
  assert.deepEqual(splitArgs('vite  --mode "staging env" --base=\'/app/\''), ['vite', '--mode', 'staging env', '--base=/app/']);
  assert.deepEqual(splitArgs('node ""'), ['node', '']);
  assert.deepEqual(splitArgs(''), []);
});

test('viteArgsFromScript drops the flags Retakes sets itself', () => {
  assert.deepEqual(viteArgsFromScript('vite'), []);
  assert.deepEqual(viteArgsFromScript('vite --open --port 3000 --host'), []);
  assert.deepEqual(viteArgsFromScript('vite --port=3000 --strictPort --mode staging'), ['--mode', 'staging']);
  assert.deepEqual(viteArgsFromScript('vite -p 3000 --host 0.0.0.0 --config vite.dev.ts'), ['--config', 'vite.dev.ts']);
  // A bare --open followed by another flag must not swallow that flag.
  assert.deepEqual(viteArgsFromScript('vite --open --mode dev'), ['--mode', 'dev']);
});

test('resolveDevMode runs Vite directly, or the configured command', () => {
  assert.deepEqual(resolveDevMode({ scripts: { dev: 'vite --mode x' } }, {}), { kind: 'vite', args: ['--mode', 'x'] });
  assert.equal(resolveDevMode({ scripts: { dev: 'next dev' } }, { dev: 'next dev -p {port}' }).kind, 'command');
  // Vite installed but the dev script wraps it: still run Vite directly.
  assert.equal(resolveDevMode({ scripts: { dev: 'npm run x && vite' }, devDependencies: { vite: '^8' } }, {}).kind, 'vite');
  assert.deepEqual(resolveDevMode({ scripts: { dev: 'next dev --turbopack -p 3001' } }, {}), { kind: 'next', args: ['--turbopack'] });
  assert.equal(resolveDevMode({ scripts: { dev: 'run-p dev:*' }, dependencies: { next: '16' } }, {}).kind, 'next');
  assert.throws(() => resolveDevMode({ scripts: { dev: 'remix dev' } }, {}), UserError);
});

test('loadConfig validates each field', () => {
  const dir = tmp();
  assert.deepEqual(loadConfig(dir), {});
  write(dir, 'retakes.config.json', JSON.stringify({ port: 4400, agent: { model: 'haiku' } }));
  assert.deepEqual(loadConfig(dir), { port: 4400, agent: { command: undefined, args: undefined, permissionMode: undefined, model: 'haiku', effort: undefined } });

  const bad = [
    '{ not json',
    JSON.stringify({ port: 'x' }),
    JSON.stringify({ dev: 'npm run dev' }),
    JSON.stringify({ copy: ['../secret'] }),
    JSON.stringify({ copy: ['/etc/passwd'] }),
    JSON.stringify({ agent: [] }),
    JSON.stringify({ agent: { args: '--model opus' } }),
    JSON.stringify({ agent: { model: ' ' } }),
    JSON.stringify({ agent: { effort: 'turbo' } }),
  ];
  for (const text of bad) {
    write(dir, 'retakes.config.json', text);
    assert.throws(() => loadConfig(dir), UserError, text);
  }
});

test('detectPackageManager finds the nearest lockfile up to the git root', () => {
  const root = tmp();
  const app = path.join(root, 'apps', 'web');
  fs.mkdirSync(app, { recursive: true });
  assert.deepEqual(detectPackageManager(app, root), { name: 'npm', lockfile: null, root: app });
  write(root, 'pnpm-lock.yaml');
  assert.deepEqual(detectPackageManager(app, root), { name: 'pnpm', lockfile: 'pnpm-lock.yaml', root });
  write(app, 'package-lock.json');
  assert.equal(detectPackageManager(app, root).name, 'npm');
});

test('installCommand uses the frozen lockfile when there is one', () => {
  assert.deepEqual(installCommand({ name: 'npm', lockfile: 'package-lock.json' }), ['npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline']]);
  assert.deepEqual(installCommand({ name: 'npm', lockfile: null })[1][0], 'install');
  assert.deepEqual(installCommand({ name: 'pnpm', lockfile: 'pnpm-lock.yaml' }), ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']]);
});

test('filesToCopy picks up .env files by default', () => {
  const dir = tmp();
  for (const f of ['.env', '.env.local', '.env.development.local', '.envrc', 'env.txt']) write(dir, f);
  fs.mkdirSync(path.join(dir, '.env.d'));
  assert.deepEqual(filesToCopy(dir, {}).sort(), ['.env', '.env.development.local', '.env.local']);
  assert.deepEqual(filesToCopy(dir, { copy: ['.envrc', 'missing.json'] }), ['.envrc']);
});

test('slug makes a safe folder name', () => {
  assert.equal(slug('@acme/Web App!'), 'acme-web-app');
  assert.equal(slug('***'), 'app');
});

test('nextArgsFromScript keeps flags but drops the port and hostname', () => {
  assert.deepEqual(nextArgsFromScript('next dev'), []);
  assert.deepEqual(nextArgsFromScript('next dev --turbopack --port=3000 -H 0.0.0.0'), ['--turbopack']);
  assert.deepEqual(nextArgsFromScript('next dev -p 3000 --webpack'), ['--webpack']);
});
