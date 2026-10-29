// End-to-end test: a real Vite + React app, the real retakes command, a real browser, and a
// mock Claude Code that edits files the way the real one does. Run with `npm run test:e2e`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeApp, ROOT } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.RETAKES_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-e2e-'));
const SHOTS = path.join(BASE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const HOME = fs.mkdtempSync(path.join(BASE, 'home-'));
const MOCK_LOG = path.join(BASE, `mock-${Date.now()}.jsonl`);
const PORT = 4400 + Math.floor(Math.random() * 300);
const MOCK = path.join(ROOT, 'test', 'e2e', 'mock-agent.mjs');

let passed = 0;
const results = [];
function ok(cond, msg) {
  if (!cond) throw new Error(`Expected: ${msg}`);
}
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    console.log(results[results.length - 1]);
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

// ---------- start ----------
console.log(`Setting up a fixture app in ${BASE}`);
const { dir: APP, git } = makeApp({ base: BASE, config: { agent: { command: `node ${MOCK}` } } });
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
let page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const URL0 = `http://localhost:${PORT}/`;

async function shutdown() {
  await browser.close().catch(() => {});
  await stopRetakes().catch(() => {});
}

const dock = () => page.locator('retakes-dock .dock');
const tile = (label) => page.locator(`retakes-dock .tiles button[aria-label^="${label},"]`);
const token = () => page.evaluate(() => window.__RETAKES__.token);
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
async function state() {
  return (await apiCall('state')).body;
}
async function version(id) {
  return (await state()).versions.find((v) => v.id === id);
}
async function waitReady(id, timeout = 180000) {
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
async function toastText() {
  return page.evaluate(() => {
    const host = document.querySelector('retakes-dock');
    const el = host && host.shadowRoot.querySelector('.nt-root');
    return el ? el.textContent : '';
  });
}

try {
  await step('retakes starts the app and serves it on one port', async () => {
    await startRetakes();
    await page.goto(URL0);
    await dock().waitFor({ timeout: 10000 });
    ok((await page.locator('.greeting').textContent()) === 'hello from env', 'the app renders');
    ok((await page.evaluate(() => window.__RETAKES__.v)) === 'main', 'main is served');
  });

  await step('the dock shows main and a disabled Keep', async () => {
    await until(async () => (await tile('main').count()) === 1, 'main tile');
    ok(await page.locator('retakes-dock button[aria-label^="Keep"]').isDisabled(), 'Keep is disabled on main');
    ok((await dock().getAttribute('data-edge')) === 'bottom', 'docked at the bottom');
    await page.screenshot({ path: path.join(SHOTS, '01-main.png') });
  });

  await step('the API refuses requests without the token or from other hosts', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/__retakes/api/takes`, { method: 'POST', body: '{"prompt":"x"}' });
    ok(res.status === 403, `no token -> 403 (got ${res.status})`);
    const t = await token();
    const status2 = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: PORT, path: '/__retakes/api/state', headers: { 'x-retakes-token': t, host: 'evil.example' } }, (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .on('error', reject);
    });
    ok(status2 === 403, `foreign host -> 403 (got ${status2})`);
    const res4 = await fetch(`http://127.0.0.1:${PORT}/__retakes/api/state`, { headers: { 'x-retakes-token': t } });
    ok(res4.status === 200, `right token on localhost -> 200 (got ${res4.status})`);
    const res3 = await fetch(`http://127.0.0.1:${PORT}/__retakes/events?t=nope`);
    ok(res3.status === 403, 'events need the token');
  });

  await step('Prompt: point at the search button, describe the change, start a take', async () => {
    await page.evaluate(() => scrollTo(0, 500));
    await page.locator('retakes-dock button[aria-label="Prompt a change"]').click();
    await page.locator('retakes-dock .pick-hint').waitFor();
    await page.evaluate(() => scrollTo(0, 0));
    const btn = page.locator('.search-button');
    const box = await btn.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('retakes-dock .pick-box').waitFor();
    ok((await page.locator('retakes-dock .pick-tag').textContent()).includes('SearchBar'), 'the picker names the React component');
    await page.screenshot({ path: path.join(SHOTS, '02-picking.png') });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('retakes-dock .chip').waitFor();
    ok((await page.locator('retakes-dock .chip').textContent()).includes('SearchBar'), 'the composer shows the element');
    await page.locator('retakes-dock textarea').fill('make the search bar larger');
    await page.screenshot({ path: path.join(SHOTS, '03-compose.png') });
    await page.locator('retakes-dock textarea').press('Enter');
    await until(async () => (await toastText()).includes('agent-1 is on it'), 'the "on it" toast');
    await until(async () => (await tile('agent-1').count()) === 1, 'agent-1 tile');
  });

  await step('the agent runs in its own worktree with Sonnet and the element context', async () => {
    const call = await until(() => mockCalls()[0], 'the mock agent was called', 20000);
    ok(call.args.includes('-p'), 'print mode');
    ok(call.args.join(' ').includes('--model sonnet'), 'Sonnet by default');
    ok(call.args.join(' ').includes('--permission-mode acceptEdits'), 'acceptEdits');
    ok(call.args.includes('--session-id'), 'a fixed session id');
    ok(!call.args.includes('--resume'), 'no resume on the first run');
    ok(call.prompt.includes('make the search bar larger'), 'the request is in the prompt');
    ok(call.prompt.includes('SearchBar'), 'the component is in the prompt');
    ok(call.prompt.includes('search-button'), 'the selector is in the prompt');
    ok(call.cwd.startsWith(HOME), `runs in the take folder (${call.cwd})`);
    ok(fs.existsSync(path.join(call.cwd, '.env.local')), '.env.local was copied into the take');
  });

  let t1;
  await step('the take installs, starts its dev server and finishes', async () => {
    const mid = await until(async () => (await version('t1'))?.agent.status === 'running' && (await version('t1')), 'agent running');
    ok(mid.label === 'agent-1', 'labelled agent-1');
    await page.screenshot({ path: path.join(SHOTS, '04-building.png') });
    t1 = await waitReady('t1');
    ok(t1.agent.status === 'done', `agent done (${t1.agent.status}: ${t1.agent.error})`);
    ok(t1.lastResult && t1.lastResult.includes('Done'), 'result text kept');
    const log = git('log', '--format=%s', 'retakes/take-1', '-n', '1').trim();
    ok(log === 'agent-1: make the search bar larger', `commit message (${log})`);
    const files = git('show', '--name-only', '--format=', 'retakes/take-1').trim();
    ok(files === 'src/SearchBar.jsx', `only the edited file is committed (${files})`);
    await until(async () => (await toastText()).includes('agent-1 is done'), 'done toast');
  });

  await step('switching to agent-1 keeps the URL and scroll, and shows its change', async () => {
    await page.evaluate(() => scrollTo(0, 640));
    await page.waitForTimeout(150);
    await tile('agent-1').click();
    await page.waitForLoadState('load');
    await until(async () => (await page.evaluate(() => window.__RETAKES__ && window.__RETAKES__.v)) === 't1', 'agent-1 served');
    await until(async () => (await page.locator('.search-button').textContent()) === 'Search big 1', 'the change shows');
    await until(async () => Math.abs((await page.evaluate(() => scrollY)) - 640) < 4, 'scroll restored', 5000);
    ok((await page.locator('.greeting').textContent()) === 'hello from env', 'env file works in the take');
    ok(page.url() === URL0, 'same URL');
    ok((await page.locator('retakes-dock .now').textContent()).includes('agent-1'), 'Now label says agent-1');
    await until(async () => (await toastText()).includes('Viewing agent-1'), 'viewing toast');
    await page.screenshot({ path: path.join(SHOTS, '05-viewing-take.png') });
  });

  await step('a follow-up resumes the same session and lands live without a reload', async () => {
    await page.evaluate(() => (window.__noReload = 1));
    await page.locator('retakes-dock .now').click();
    await page.locator('retakes-dock .pop textarea').waitFor();
    await page.screenshot({ path: path.join(SHOTS, '06-popover.png') });
    await page.locator('retakes-dock .pop textarea').fill('make the search button blue');
    await page.locator('retakes-dock .pop button', { hasText: 'Send' }).click();
    await until(
      async () => (await page.locator('.search-button').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(43, 69, 224)',
      'button turns blue live',
      30000
    );
    ok((await page.evaluate(() => window.__noReload)) === 1, 'no page reload (hot update)');
    const calls = mockCalls();
    const second = calls[1];
    ok(second.args.includes('--resume'), 'resumes');
    ok(second.args[second.args.indexOf('--resume') + 1] === calls[0].args[calls[0].args.indexOf('--session-id') + 1], 'same session id');
    await waitReady('t1');
    const n = Number(git('rev-list', '--count', 'main..retakes/take-1').trim());
    ok(n === 2, `two commits on the take (${n})`);
  });

  await step('errors in the browser badge the take, and Fix sends them to its agent', async () => {
    await apiCall('takes/t1/followup', { prompt: 'break the clear button' });
    await waitReady('t1');
    await page.reload();
    await page.locator('.clear').click();
    await until(async () => (await version('t1')).errors.length > 0, 'error reported');
    const v = await version('t1');
    ok(/undefined|map/i.test(v.errors[0].message), `error message (${v.errors[0].message})`);
    await until(async () => (await tile('agent-1').getAttribute('aria-label')).includes('error'), 'tile shows the error');
    await until(async () => (await toastText()).includes('agent-1 hit an error'), 'error toast');
    await page.screenshot({ path: path.join(SHOTS, '07-error.png') });
    const r = await apiCall('takes/t1/fix', {});
    ok(r.status === 200, 'fix accepted');
    const fixCall = await until(() => mockCalls().find((c) => c.prompt.includes('errors in the browser')), 'fix prompt sent');
    ok(fixCall.prompt.includes(v.errors[0].message.slice(0, 30)), 'the error is in the fix prompt');
    const after = await waitReady('t1');
    ok(after.errors.length === 0, 'errors cleared after the fix');
    await page.reload();
    await page.locator('.clear').click();
    await page.waitForTimeout(800);
    ok((await version('t1')).errors.length === 0, 'no new errors after the fix');
    ok((await page.locator('.chip').count()) === 0, 'clearing works now');
  });

  await step('Try another starts a second take of the same prompt', async () => {
    const r = await apiCall('takes/t1/another', {});
    ok(r.status === 200 && r.body.take.id === 't2', `agent-2 created (${JSON.stringify(r)})`);
    ok(r.body.take.attempt === 2, 'it is take 2');
    const t2 = await waitReady('t2');
    ok(t2.prompt === 'make the search bar larger', 'same prompt');
    const call = mockCalls().find((c) => c.prompt.includes('This is take 2'));
    ok(call, 'the prompt asks for a different take');
  });

  await step('Compare shows two versions side by side and scrolls them together', async () => {
    await page.locator('retakes-dock button[aria-label="Compare side by side"]').click();
    await page.locator('retakes-dock .cmp').waitFor();
    const frames = page.locator('retakes-dock .cmp iframe');
    await until(async () => (await frames.count()) === 2, 'two panes');
    const left = page.frameLocator('retakes-dock .cmp .pane:nth-child(1) iframe');
    const right = page.frameLocator('retakes-dock .cmp .pane:nth-child(2) iframe');
    await until(async () => (await left.locator('.search-button').textContent()) === 'Search big 1', 'left is agent-1', 20000);
    await until(async () => (await right.locator('.search-button').textContent()) === 'Search', 'right is main', 20000);
    await page.waitForTimeout(500);
    const panes = page.frames().filter((f) => f.parentFrame() === page.mainFrame());
    ok(panes.length === 2, `two pane frames (${panes.length})`);
    await panes[0].evaluate(() => scrollTo(0, 700));
    await until(async () => Math.abs((await panes[1].evaluate(() => scrollY)) - 700) < 4, 'the other pane follows', 5000);
    await page.screenshot({ path: path.join(SHOTS, '08-compare.png') });
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('retakes-dock .cmp').count()) === 0, 'compare closes');
  });

  await step('Keep merges a take into your branch and removes it', async () => {
    await tile('agent-2').click();
    await until(async () => (await page.evaluate(() => window.__RETAKES__ && window.__RETAKES__.v)) === 't2', 'agent-2 served');
    await page.locator('retakes-dock button[aria-label="Keep agent-2"]').click();
    await page.screenshot({ path: path.join(SHOTS, '09-keep.png') });
    await page.locator('retakes-dock .pop button', { hasText: 'Keep agent-2' }).click();
    await until(async () => (await page.evaluate(() => window.__RETAKES__ && window.__RETAKES__.v)) === 'main', 'back on main', 20000);
    await until(async () => (await page.locator('.search-button').textContent()) === 'Search big 2', 'main has the change');
    const subject = git('log', '-1', '--format=%s').trim();
    ok(subject.startsWith('Keep agent-2'), `merge commit (${subject})`);
    ok(!git('branch', '--list', 'retakes/take-2').trim(), 'branch removed');
    ok(!(await version('t2')), 'take removed');
    ok(!fs.existsSync(path.join(HOME, 'projects')) || !fs.readdirSync(path.join(HOME, 'projects')).some((p) => fs.existsSync(path.join(HOME, 'projects', p, 'takes', 't2'))), 'folder removed');
  });

  await step('Discard removes a take, its branch and its folder', async () => {
    await tile('agent-1').click();
    await until(async () => (await page.evaluate(() => window.__RETAKES__ && window.__RETAKES__.v)) === 't1', 'agent-1 served');
    await page.locator('retakes-dock .now').click();
    const discard = page.locator('retakes-dock .pop button', { hasText: 'Discard' });
    await discard.click();
    await page.locator('retakes-dock .pop button', { hasText: 'Click again to discard' }).click();
    await until(async () => (await page.evaluate(() => window.__RETAKES__ && window.__RETAKES__.v)) === 'main', 'back on main', 20000);
    ok(!git('branch', '--list', 'retakes/take-1').trim(), 'branch removed');
    ok(!(await version('t1')), 'take removed');
    ok(!git('worktree', 'list').includes('takes/t1'), 'worktree removed');
  });

  await step('the dock docks to the left as a column and remembers it', async () => {
    const handle = page.locator('retakes-dock .handle');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + 20, hb.y + 20);
    await page.mouse.down();
    await page.mouse.move(400, 400, { steps: 6 });
    await page.mouse.move(30, 380, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await dock().getAttribute('data-edge')) === 'left', 'docked left');
    ok((await dock().getAttribute('aria-orientation')) === 'vertical', 'vertical');
    await page.waitForTimeout(400);
    const b = await dock().boundingBox();
    ok(Math.abs(b.x - 12) < 2, `12px from the edge (${b.x})`);
    await page.screenshot({ path: path.join(SHOTS, '10-left.png') });
    await page.reload();
    await dock().waitFor();
    ok((await dock().getAttribute('data-edge')) === 'left', 'remembered after reload');
    // Put it back, once it has settled from the reload.
    await page.waitForTimeout(600);
    const hb2 = await page.locator('retakes-dock .handle').boundingBox();
    await page.mouse.move(hb2.x + 20, hb2.y + 20);
    await page.mouse.down();
    await page.mouse.move(600, 500, { steps: 6 });
    await page.mouse.move(640, 790, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await dock().getAttribute('data-edge')) === 'bottom', 'back at the bottom');
  });

  await step('docked at the top, notifications move to the bottom', async () => {
    await page.waitForTimeout(600); // let the dock settle from the last drag
    const hb = await page.locator('retakes-dock .handle').boundingBox();
    await page.mouse.move(hb.x + 20, hb.y + 20);
    await page.mouse.down();
    await page.mouse.move(600, 300, { steps: 6 });
    await page.mouse.move(640, 15, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await dock().getAttribute('data-edge')) === 'top', 'docked at the top');
    // "Hide until reload" shows a notification; bring the dock straight back to compare positions.
    await page.locator('retakes-dock .handle').click({ button: 'right' });
    await page.locator('retakes-dock .pop button', { hasText: 'Hide until reload' }).click();
    await until(async () => (await toastText()).includes('Dock hidden'), 'hidden toast');
    await page.keyboard.press('.');
    await dock().waitFor();
    await page.waitForTimeout(500);
    const d = await dock().boundingBox();
    const t = await page.evaluate(() => {
      const el = document.querySelector('retakes-dock').shadowRoot.querySelector('.nt-root');
      const r = [...el.querySelectorAll('*')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 40 && r.height > 20)[0];
      return r && { top: r.top, bottom: r.bottom };
    });
    ok(t && t.top > 400, `toast at the bottom (${JSON.stringify(t)})`);
    ok(t.top > d.y + d.height, 'toast and dock do not overlap');
    await page.screenshot({ path: path.join(SHOTS, '10b-top.png') });
    const hb2 = await page.locator('retakes-dock .handle').boundingBox();
    await page.mouse.move(hb2.x + 20, hb2.y + 20);
    await page.mouse.down();
    await page.mouse.move(600, 500, { steps: 6 });
    await page.mouse.move(640, 790, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await dock().getAttribute('data-edge')) === 'bottom', 'back at the bottom');
  });

  await step('P opens the pick tool, but not while typing in the app', async () => {
    await page.locator('.search-input').click();
    await page.keyboard.type('p');
    ok(!(await page.locator('retakes-dock .pick-hint').isVisible()), 'typing p in the app does nothing');
    await page.locator('.search-input').fill('');
    await page.locator('body').click({ position: { x: 600, y: 110 } });
    await page.keyboard.press('p');
    await page.locator('retakes-dock .pick-hint').waitFor();
    await page.keyboard.press('Escape');
    await until(async () => !(await page.locator('retakes-dock .pick-hint').isVisible()), 'picker closed');
  });

  await step('. collapses and opens the dock; clicking the handle does too', async () => {
    await page.locator('body').click({ position: { x: 600, y: 120 } });
    await page.keyboard.press('.');
    await until(async () => (await dock().getAttribute('class')).includes('closed'), 'collapsed');
    await page.screenshot({ path: path.join(SHOTS, '11-collapsed.png') });
    await page.keyboard.press('.');
    await until(async () => !(await dock().getAttribute('class')).includes('closed'), 'open');
    await page.locator('retakes-dock .handle').click();
    await until(async () => (await dock().getAttribute('class')).includes('closed'), 'collapsed by click');
    await page.locator('retakes-dock .handle').click();
    await until(async () => !(await dock().getAttribute('class')).includes('closed'), 'open by click');
    await page.locator('.search-input').fill('a.b');
    ok((await page.locator('.search-input').inputValue()) === 'a.b', 'typing . in the app does not toggle the dock');
    ok(!(await dock().getAttribute('class')).includes('closed'), 'still open');
  });

  await step('a failing agent is reported and its take can be discarded', async () => {
    const r = await apiCall('takes', { prompt: 'fail on purpose' });
    ok(r.status === 200, 'created');
    const id = r.body.take.id;
    await until(async () => (await version(id)).agent.status === 'failed', 'agent failed', 60000);
    const v = await version(id);
    ok(v.agent.error.includes('Mock failure'), `error kept (${v.agent.error})`);
    await until(async () => (await toastText()).includes('hit a problem'), 'failure toast');
    await waitReady(id);
    await apiCall(`takes/${id}/discard`, {});
    await until(async () => !(await version(id)), 'removed');
  });

  await step('an expired Claude sign-in says how to fix it, and Retry resumes the take', async () => {
    const r = await apiCall('takes', { prompt: 'signin then widen the search' });
    const id = r.body.take.id;
    await until(async () => (await version(id)).agent.status === 'failed', 'agent failed', 60000);
    let v = await version(id);
    ok(v.agent.error.startsWith('Claude Code needs you to sign in again.'), `plain message (${v.agent.error})`);
    ok(v.agent.error.includes('/login') && v.agent.error.includes('OAuth session expired'), 'says how, keeps the original');
    ok(v.canRetry, 'can retry');
    await until(async () => (await toastText()).includes('needs you to sign in'), 'sign-in toast');
    await page.locator('retakes-dock .nt-root button', { hasText: 'Details' }).click();
    const retry = page.locator('retakes-dock .pop button', { hasText: 'Retry' });
    await retry.waitFor();
    await page.screenshot({ path: path.join(SHOTS, '12-signin.png') });
    const first = mockCalls().at(-1);
    await retry.click();
    await until(async () => (await version(id)).agent.status === 'done', 'retry finished', 60000);
    const again = mockCalls().at(-1);
    const sid = first.args[first.args.indexOf('--session-id') + 1];
    ok(again.args[again.args.indexOf('--resume') + 1] === sid, 'retry resumes the same session');
    ok(again.prompt.includes('signin then widen the search') && again.prompt.includes('Pick up where you left off'), 'retry asks to finish the request');
    v = await version(id);
    ok(!v.canRetry && !v.agent.error, 'no longer failed');
    await page.keyboard.press('Escape');
    await waitReady(id);
    await apiCall(`takes/${id}/discard`, {});
    await until(async () => !(await version(id)), 'removed');
  });

  await step('Stop ends a running agent', async () => {
    const r = await apiCall('takes', { prompt: 'slow change please' });
    const id = r.body.take.id;
    await until(async () => (await version(id)).agent.status === 'running', 'running');
    await page.waitForTimeout(800);
    await apiCall(`takes/${id}/stop`, {});
    await until(async () => (await version(id)).agent.status === 'stopped', 'stopped', 15000);
    await waitReady(id);
  });

  await step('takes survive a restart of retakes', async () => {
    const before = (await state()).versions.filter((v) => v.kind === 'take').map((v) => v.id);
    ok(before.length === 1, 'one take left');
    await stopRetakes();
    ok(/Stopping dev servers/.test(retakesOut), 'clean shutdown');
    retakesOut = '';
    await startRetakes();
    await page.reload();
    await dock().waitFor();
    const v = await waitReady(before[0], 60000);
    ok(v.agent.status === 'stopped', 'stopped status kept');
    ok(!/installing dependencies/.test(retakesOut), 'no reinstall on restart');
  });

  await step('retakes clean removes every take', async () => {
    await stopRetakes();
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'retakes.js'), 'clean', '--yes'], {
      cwd: APP,
      env: { ...process.env, RETAKES_HOME: HOME },
    }).toString();
    ok(/Cleaned/.test(out), out);
    ok(!git('branch', '--list', 'retakes/*').trim(), 'no retakes branches');
    ok(git('worktree', 'list').trim().split('\n').length === 1, 'only the main worktree');
    ok(git('status', '--porcelain').trim() === '', 'your checkout is clean');
  });

  const unexpected = pageErrors.filter((m) => !/undefined|map/i.test(m));
  ok(unexpected.length === 0, `no unexpected page errors: ${unexpected.join(' | ')}`);
  console.log(`\nAll ${passed} steps passed. Screenshots in ${SHOTS}`);
} finally {
  await shutdown();
}
