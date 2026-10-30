// End-to-end test for Retakes Pro: a fake Polar license server, `retakes activate`, three takes
// from one prompt, and Compare with four panes. Run with `npm run test:e2e:pro`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { makeApp, ROOT } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.RETAKES_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-pro-'));
const SHOTS = path.join(BASE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const HOME = fs.mkdtempSync(path.join(BASE, 'home-'));
const MOCK_LOG = path.join(BASE, `mock-${Date.now()}.jsonl`);
const PORT = 4700 + Math.floor(Math.random() * 200);
const MOCK = path.join(ROOT, 'test', 'e2e', 'mock-agent.mjs');
const KEY = 'RETAKES-PRO-TEST-0001';

// ---------- a fake Polar ----------
const polarCalls = [];
const polar = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const action = req.url.split('/').pop();
    const json = JSON.parse(body || '{}');
    polarCalls.push({ action, ...json });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (json.organization_id !== 'org-test') return send(422, { detail: 'wrong organization' });
    if (json.key !== KEY) return send(404, { detail: 'Not found' });
    if (action === 'activate') return send(200, { id: 'act-1', license_key: { status: 'granted', expires_at: null } });
    if (action === 'validate') return send(200, { status: 'granted', expires_at: null });
    if (action === 'deactivate') return send(204);
    send(404, { detail: 'Not found' });
  });
});
await new Promise((r) => polar.listen(0, '127.0.0.1', r));
const ENV = {
  ...process.env,
  RETAKES_HOME: HOME,
  RETAKES_MOCK_LOG: MOCK_LOG,
  RETAKES_MOCK_STEP_MS: '600',
  RETAKES_POLAR_ORG: 'org-test',
  RETAKES_LICENSE_API: `http://127.0.0.1:${polar.address().port}/v1/customer-portal/license-keys`,
};

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
    try {
      await page.screenshot({ path: path.join(SHOTS, `fail-${name.replace(/\W+/g, '-')}.png`) });
    } catch {
      /* no page */
    }
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
// Async, so the fake Polar in this process can answer while the command runs.
const cli = async (...args) => (await promisify(execFile)(process.execPath, [path.join(ROOT, 'bin', 'retakes.js'), ...args], { cwd: APP, env: ENV })).stdout;

console.log(`Setting up a fixture app in ${BASE}`);
const { dir: APP } = makeApp({ base: BASE, config: { agent: { command: `node ${MOCK}` } } });

let retakes = null;
let retakesOut = '';
function startRetakes() {
  retakesOut = '';
  retakes = spawn(process.execPath, [path.join(ROOT, 'bin', 'retakes.js'), '--no-open', '--port', String(PORT)], { cwd: APP, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  retakes.stdout.on('data', (d) => (retakesOut += d));
  retakes.stderr.on('data', (d) => (retakesOut += d));
  return until(() => /main: dev server ready/.test(retakesOut), 'main dev server ready', 60000);
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
const URL0 = `http://localhost:${PORT}/`;
async function shutdown() {
  await browser.close().catch(() => {});
  await stopRetakes().catch(() => {});
  polar.close();
}
const dock = () => page.locator('retakes-dock .dock');
async function apiCall(p, body) {
  return page.evaluate(
    async ([p, body]) => {
      const r = await fetch(`/__retakes/api/${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-retakes-token': window.__RETAKES__.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [p, body]
  );
}
const state = async () => (await apiCall('state')).body;
const toastText = () =>
  page.evaluate(() => {
    const el = document.querySelector('retakes-dock').shadowRoot.querySelector('.nt-root');
    return el ? el.textContent : '';
  });
async function openComposer() {
  await page.keyboard.press('p');
  await page.locator('retakes-dock .pick-hint').waitFor();
  await page.keyboard.press('Enter');
  await page.locator('retakes-dock .opts').waitFor();
}

try {
  await step('without a key, three takes at once is offered as Pro and refused by the hub', async () => {
    await startRetakes();
    await page.goto(URL0);
    await dock().waitFor({ timeout: 10000 });
    const s = await state();
    ok(s.pro && s.pro.active === false && s.pro.maxBatch === 3, 'snapshot says Pro is off');
    await openComposer();
    const three = page.locator('retakes-dock .opts button', { hasText: '3 at once' });
    ok((await three.locator('.pro').count()) === 1, 'the button carries a Pro label');
    await page.screenshot({ path: path.join(SHOTS, '01-free-composer.png') });
    await three.click();
    await until(async () => /part of Retakes Pro/.test(await toastText()), 'a Pro notification');
    ok((await three.getAttribute('aria-pressed')) === 'false', 'the pick stays on one');
    const r = await apiCall('takes', { prompt: 'make the search bar larger', count: 3 });
    ok(r.status === 400 && /Retakes Pro/.test(r.body.error), `hub refuses (${r.status} ${JSON.stringify(r.body)})`);
    ok((await state()).versions.length === 1, 'no take was started');
    await page.keyboard.press('Escape');
    await stopRetakes();
  });

  await step('retakes activate checks the key with Polar and saves it', async () => {
    let failed = '';
    try {
      await cli('activate', 'WRONG-KEY-0000');
    } catch (err) {
      failed = String(err.stderr || err.stdout);
    }
    ok(/wasn't found/.test(failed), `a wrong key is refused: ${failed}`);
    const out = await cli('activate', KEY);
    ok(/Retakes Pro is on/.test(out), out);
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'license.json'), 'utf8'));
    ok(saved.key === KEY && saved.activationId === 'act-1' && saved.status === 'granted', 'license.json');
    ok(/Retakes Pro is on \(RETA…0001\)/.test(await cli('license')), 'retakes license shows it, masked');
  });

  await step('with Pro, one prompt starts three takes, each asked for a different approach', async () => {
    await startRetakes();
    await page.reload();
    await dock().waitFor();
    await until(async () => (await state()).pro.active, 'Pro is on in the dock');
    await openComposer();
    const three = page.locator('retakes-dock .opts button', { hasText: '3 at once' });
    ok((await three.locator('.pro').count()) === 0, 'no Pro label once unlocked');
    await three.click();
    ok((await three.getAttribute('aria-pressed')) === 'true', '3 at once is picked');
    await page.locator('retakes-dock textarea').fill('make the search bar larger');
    await page.screenshot({ path: path.join(SHOTS, '02-pro-composer.png') });
    await page.locator('retakes-dock .pbtn.primary', { hasText: 'Start 3 agents' }).click();
    await until(async () => /agent-1, agent-2, agent-3 are on it/.test(await toastText()), 'the three-take notification');
    const takes = await until(async () => {
      const vs = (await state()).versions.filter((v) => v.kind === 'take');
      return vs.length === 3 && vs.every((v) => v.switchable && v.agent.status === 'done') ? vs : false;
    }, 'three finished takes', 180000, 500);
    ok(takes[1].takeOf === takes[0].id && takes[2].takeOf === takes[0].id, 'grouped under the first take');
    ok(takes.map((t) => t.attempt).join() === '1,2,3', 'attempts 1, 2 and 3');
    const prompts = mockCalls().map((c) => c.prompt);
    ok(prompts.some((p) => /This is take 2 of the same request/.test(p)) && prompts.some((p) => /This is take 3/.test(p)), 'takes 2 and 3 ask for something different');
    ok(polarCalls.some((c) => c.action === 'validate') || polarCalls.filter((c) => c.action === 'activate').length >= 1, 'Polar was asked');
  });

  await step('Compare adds up to four panes and scrolls them all together', async () => {
    await page.locator('retakes-dock button[aria-label="Compare side by side"]').click();
    await page.locator('retakes-dock .cmp').waitFor();
    const add = page.locator('retakes-dock .cmp-bar .pbtn', { hasText: 'Add' });
    await add.click();
    await add.click();
    ok((await add.count()) === 0, 'Add disappears at four');
    const frames = page.locator('retakes-dock .cmp iframe');
    await until(async () => (await frames.count()) === 4, 'four panes', 20000);
    const labels = [];
    for (let i = 1; i <= 4; i++) {
      const f = page.frameLocator(`retakes-dock .cmp .pane:nth-child(${i}) iframe`);
      labels.push(await until(async () => f.locator('.search-button').textContent(), `pane ${i} renders`, 20000));
    }
    ok(new Set(labels).size === 4 && labels.includes('Search') && labels.includes('Search big 3'), `four different versions: ${labels.join(' | ')}`);
    await page.waitForTimeout(500);
    const panes = page.frames().filter((f) => f.parentFrame() === page.mainFrame());
    ok(panes.length === 4, `four pane frames (${panes.length})`);
    await panes[0].evaluate(() => scrollTo(0, 600));
    for (const p of panes.slice(1)) await until(async () => Math.abs((await p.evaluate(() => scrollY)) - 600) < 4, 'every pane follows', 5000);
    await page.screenshot({ path: path.join(SHOTS, '03-compare-four.png') });
    await page.locator('retakes-dock button[aria-label="Remove pane 4"]').click();
    await until(async () => (await frames.count()) === 3, 'back to three panes');
    await page.keyboard.press('Escape');
  });

  await step('retakes deactivate frees the key and turns Pro off', async () => {
    await stopRetakes();
    ok(/Pro is off/.test(await cli('deactivate')), 'deactivated');
    ok(polarCalls.some((c) => c.action === 'deactivate' && c.activation_id === 'act-1'), 'Polar was told');
    ok(!fs.existsSync(path.join(HOME, 'license.json')), 'license.json removed');
    ok(/isn't on here/.test(await cli('license')), 'retakes license says it is off');
    await cli('clean', '--yes');
  });

  console.log(`\nAll ${passed} steps passed. Screenshots in ${SHOTS}`);
} finally {
  await shutdown();
}
