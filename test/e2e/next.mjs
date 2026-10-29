// End-to-end test for Next.js: a real Next 16 app (App Router, server and client components),
// the real retakes command, a real browser and the mock Claude Code. Run with `npm run test:e2e:next`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeApp, ROOT } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.RETAKES_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-e2e-'));
const SHOTS = path.join(BASE, 'shots-next');
fs.mkdirSync(SHOTS, { recursive: true });
const HOME = fs.mkdtempSync(path.join(BASE, 'home-'));
const MOCK_LOG = path.join(BASE, `mock-next-${Date.now()}.jsonl`);
const PORT = 4700 + Math.floor(Math.random() * 200);
const MOCK = path.join(ROOT, 'test', 'e2e', 'mock-agent.mjs');

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`Expected: ${msg}`);
}
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.stack || err.message}`);
    await page.screenshot({ path: path.join(SHOTS, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    console.log(`\nretakes output:\n${retakesOut.slice(-4000)}`);
    await shutdown();
    process.exit(1);
  }
}
async function until(fn, msg, timeout = 30000, every = 250) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`Timed out waiting for: ${msg} (last: ${JSON.stringify(last)})`);
}
const mockCalls = () =>
  fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

console.log(`Setting up a Next.js fixture app in ${BASE}`);
const { dir: APP, git } = makeApp({
  base: BASE,
  fixture: 'next-app',
  env: 'NEXT_PUBLIC_GREETING=hello from env\n',
  config: { agent: { command: `node ${MOCK}` } },
});
console.log(`App: ${APP}\nHub port: ${PORT}`);

let retakes = null;
let retakesOut = '';
function startRetakes() {
  retakes = spawn(process.execPath, [path.join(ROOT, 'bin', 'retakes.js'), '--no-open', '--port', String(PORT)], {
    cwd: APP,
    env: { ...process.env, RETAKES_HOME: HOME, RETAKES_MOCK_LOG: MOCK_LOG, RETAKES_MOCK_STEP_MS: '900' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  retakes.stdout.on('data', (d) => (retakesOut += d));
  retakes.stderr.on('data', (d) => (retakesOut += d));
  return until(() => /main: dev server ready/.test(retakesOut), 'main dev server ready', 90000);
}
async function stopRetakes() {
  if (!retakes || retakes.exitCode !== null) return;
  const done = new Promise((r) => retakes.once('exit', r));
  retakes.kill('SIGINT');
  await done;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const URL0 = `http://localhost:${PORT}/`;

async function shutdown() {
  await browser.close().catch(() => {});
  await stopRetakes().catch(() => {});
}

const dock = () => page.locator('retakes-dock .dock');
const tile = (label) => page.locator(`retakes-dock .tiles button[aria-label^="${label},"]`);
let TOKEN = null;
// Calls go from Node, not the page, since Keep and switches reload the page mid-call.
async function apiCall(p, body) {
  if (!TOKEN) TOKEN = await page.evaluate(() => window.__RETAKES__.token);
  const r = await fetch(`${URL0}__retakes/api/${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-retakes-token': TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const version = async (id) => (await apiCall('state')).body.versions.find((v) => v.id === id);
async function waitReady(id, timeout = 240000) {
  return until(
    async () => {
      const v = await version(id);
      if (!v) return false;
      if (v.phase === 'failed') throw new Error(`setup failed: ${v.phaseError}`);
      return v.switchable && v.agent.status !== 'running' ? v : false;
    },
    `${id} ready`,
    timeout,
    500
  );
}

try {
  await step('retakes runs next dev and serves the app with the dock', async () => {
    await startRetakes();
    ok(/main: dev server ready/.test(retakesOut), 'ready');
    await page.goto(URL0);
    await dock().waitFor({ timeout: 90000 });
    ok((await page.locator('.greeting').textContent()) === 'hello from env', 'env works');
    ok((await page.title()) === 'stay', 'the app rendered');
    await page.screenshot({ path: path.join(SHOTS, '01-main.png') });
  });

  await step('the picker names client and server components', async () => {
    const pick = async (sel) => {
      await page.keyboard.press('p');
      await page.locator('retakes-dock .pick-hint').waitFor();
      const b = await page.locator(sel).first().boundingBox();
      await page.mouse.click(b.x + 5, b.y + 5);
      const chip = await page.locator('retakes-dock .chip').textContent();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      return chip;
    };
    ok((await pick('.search-button')).startsWith('SearchBar'), 'client component');
    ok((await pick('.greeting')).startsWith('Home'), 'server component, not a Next.js wrapper');
  });

  await step('a take runs its own next dev and switching shows its change', async () => {
    const r = await apiCall('takes', { prompt: 'make the search bar larger', element: { selector: 'form.search > button.search-button', component: 'SearchBar' } });
    ok(r.status === 200, `created (${JSON.stringify(r.body)})`);
    await waitReady('t1');
    ok(git('rev-list', '--count', 'main..retakes/take-1').trim() === '1', 'committed');
    await tile('agent-1').click();
    await page.waitForLoadState('load');
    await until(async () => (await page.evaluate(() => window.__RETAKES__ && window.__RETAKES__.v)) === 't1', 'agent-1 served');
    await until(async () => (await page.locator('.search-button').textContent()) === 'Search big 1', 'the change shows', 60000);
    ok((await page.locator('.greeting').textContent()) === 'hello from env', 'env copied into the take');
    ok(page.url() === URL0, 'same URL');
  });

  await step('a follow-up lands live through Next.js hot reload', async () => {
    await page.evaluate(() => (window.__noReload = 1));
    await apiCall('takes/t1/followup', { prompt: 'make the search button blue' });
    await until(
      async () => (await page.locator('.search-button').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(43, 69, 224)',
      'button turns blue live',
      60000
    );
    ok((await page.evaluate(() => window.__noReload)) === 1, 'no page reload');
    await waitReady('t1');
  });

  await step('runtime errors badge the take and Fix repairs them', async () => {
    await apiCall('takes/t1/followup', { prompt: 'break the clear button' });
    await waitReady('t1');
    await until(async () => (await page.locator('.clear').count()) === 1, 'page settled');
    await page.waitForTimeout(1500);
    await page.locator('.clear').click();
    await until(async () => (await version('t1')).errors.length > 0, 'error reported');
    ok(/undefined|map/i.test((await version('t1')).errors[0].message), 'error message');
    await until(async () => (await tile('agent-1').getAttribute('aria-label')).includes('error'), 'tile shows the error');
    await page.screenshot({ path: path.join(SHOTS, '02-error.png') });
    await apiCall('takes/t1/fix', {});
    await until(() => mockCalls().find((c) => c.prompt.includes('errors in the browser')), 'fix prompt sent');
    ok((await waitReady('t1')).errors.length === 0, 'errors cleared');
  });

  await step("build errors from Next.js's overlay are captured too", async () => {
    const dir = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: APP })
      .toString()
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice(9))
      .find((d) => d.endsWith(`${path.sep}takes${path.sep}t1`));
    ok(dir, 'found the take folder');
    const src = path.join(dir, 'src', 'Listing.jsx');
    const good = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(src, good.replace('export default function Listing', 'const oops = ;\nexport default function Listing'));
    await until(async () => (await version('t1')).errors.some((e) => e.kind === 'build'), 'build error reported', 60000);
    const e = (await version('t1')).errors.find((x) => x.kind === 'build');
    ok(/Build Error/i.test(e.message) && /Listing\.jsx/.test(e.stack), `useful details (${e.message} | ${e.stack.slice(0, 80)})`);
    await page.screenshot({ path: path.join(SHOTS, '03-build-error.png') });
    fs.writeFileSync(src, good);
    await apiCall('versions/t1/clear-errors', {});
  });

  await step('Keep merges the take into main', async () => {
    await page.waitForTimeout(1500);
    const r = await apiCall('takes/t1/keep', {});
    ok(r.status === 200, `kept (${JSON.stringify(r.body)})`);
    ok(/Keep agent-1/.test(git('log', '-1', '--format=%s')), 'merge commit');
    await until(async () => !(await version('t1')), 'take removed');
    await page.goto(URL0);
    await until(async () => (await page.locator('.search-button').textContent()) === 'Search big 1', 'main has the change', 60000);
  });

  await step('retakes stops cleanly and clean leaves the checkout tidy', async () => {
    await stopRetakes();
    ok(/Stopping dev servers/.test(retakesOut), 'clean shutdown');
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'retakes.js'), 'clean', '--yes'], { cwd: APP, env: { ...process.env, RETAKES_HOME: HOME } });
    ok(!git('branch', '--list', 'retakes/*').trim(), 'no retakes branches');
    ok(git('status', '--porcelain').trim() === '', 'your checkout is clean');
  });

  const unexpected = pageErrors.filter((m) => !/undefined|map/i.test(m));
  ok(unexpected.length === 0, `no unexpected page errors: ${unexpected.join(' | ')}`);
  console.log(`\nAll ${passed} Next.js steps passed. Screenshots in ${SHOTS}`);
} finally {
  await shutdown();
}
