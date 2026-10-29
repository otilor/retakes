// End-to-end test for recorded flows: record one in the dock on a real Vite app, then let
// Orchestrator replay it with Playwright on each take. Run with `npm run test:e2e:flows`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeApp, ROOT } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.ORCH_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
const SHOTS = path.join(BASE, 'shots-flows');
fs.mkdirSync(SHOTS, { recursive: true });
const HOME = fs.mkdtempSync(path.join(BASE, 'home-'));
const MOCK_LOG = path.join(BASE, `mock-flows-${Date.now()}.jsonl`);
const PORT = 4900 + Math.floor(Math.random() * 200);
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
    console.log(`\norch output:\n${orchOut.slice(-4000)}`);
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

console.log(`Setting up a fixture app in ${BASE}`);
const { dir: APP, git } = makeApp({ base: BASE, config: { agent: { command: `node ${MOCK}` } } });
console.log(`App: ${APP}\nHub port: ${PORT}`);

let orch = null;
let orchOut = '';
function startOrch() {
  orch = spawn(process.execPath, [path.join(ROOT, 'bin', 'orch.js'), '--no-open', '--port', String(PORT)], {
    cwd: APP,
    env: { ...process.env, ORCH_HOME: HOME, ORCH_MOCK_LOG: MOCK_LOG, ORCH_MOCK_STEP_MS: '900' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  orch.stdout.on('data', (d) => (orchOut += d));
  orch.stderr.on('data', (d) => (orchOut += d));
  return until(() => /main: dev server ready/.test(orchOut), 'main dev server ready', 90000);
}
async function stopOrch() {
  if (!orch || orch.exitCode !== null) return;
  const done = new Promise((r) => orch.once('exit', r));
  orch.kill('SIGINT');
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
  await stopOrch().catch(() => {});
}

const dock = () => page.locator('orch-dock .dock');
const tile = (label) => page.locator(`orch-dock .tiles button[aria-label^="${label},"]`);
let TOKEN = null;
// Calls go from Node, not the page, since Keep and switches reload the page mid-call.
async function apiCall(p, body) {
  if (!TOKEN) TOKEN = await page.evaluate(() => window.__ORCH__.token);
  const r = await fetch(`${URL0}__orch/api/${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-orch-token': TOKEN, 'content-type': 'application/json' },
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

const rec = () => page.locator('orch-dock .rec');
const flowOn = async (id, flow) => ((await version(id)).flows || []).find((f) => f.id === flow);
const FLOWS = () => path.join(APP, '.orch', 'flows');

try {
  await step('orch starts and the Flows panel explains itself', async () => {
    await startOrch();
    await page.goto(URL0);
    await dock().waitFor({ timeout: 30000 });
    await page.keyboard.press('f');
    await page.locator('orch-dock .pop').getByText('Record what you').waitFor();
    ok((await page.locator('orch-dock .pop button', { hasText: 'Record a flow' }).count()) === 1, 'record button');
  });

  await step('recording captures typing, Enter, clicks and a text check', async () => {
    await page.locator('orch-dock .pop button', { hasText: 'Record a flow' }).click();
    await rec().waitFor();
    ok((await dock().count()) === 0, 'the dock steps aside while recording');
    await page.locator('.search-input').click();
    await page.locator('.search-input').pressSequentially('Lisbon', { delay: 20 });
    await page.locator('.search-input').press('Enter');
    await page.locator('.clear').click();
    await until(async () => (await rec().textContent()).includes('3 steps'), 'three steps (typing is one step, Enter does not double as a click)');
    await rec().getByRole('button', { name: 'Add check' }).click();
    await page.locator('orch-dock .pick-hint').waitFor();
    const b = await page.locator('.none').boundingBox();
    await page.mouse.click(b.x + 4, b.y + 4);
    await until(async () => (await rec().textContent()).includes('4 steps'), 'the check is step 4');
    ok((await rec().textContent()).includes('No filters'), 'the bar shows the last step');
    await page.screenshot({ path: path.join(SHOTS, '01-recording.png') });
  });

  await step('a recording survives a page load', async () => {
    await page.reload();
    await rec().waitFor({ timeout: 15000 });
    ok((await rec().textContent()).includes('4 steps'), 'still four steps');
  });

  await step('saving writes the flow and its Playwright test to the repo, then replays it', async () => {
    await rec().getByRole('button', { name: 'Done' }).click();
    await page.locator('orch-dock .rec-name').fill('Clear filters');
    await rec().getByRole('button', { name: 'Save flow' }).click();
    await dock().waitFor();
    const file = path.join(FLOWS(), 'clear-filters.json');
    await until(() => fs.existsSync(file), 'flow file written');
    const flow = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(flow.name === 'Clear filters' && flow.start === '/', 'name and start');
    ok(flow.steps.map((s) => s.do).join() === 'fill,press,click,expectText', `steps: ${flow.steps.map((s) => s.do).join()}`);
    ok(flow.steps[0].value === 'Lisbon' && flow.steps[0].target[0] === 'input[aria-label="Where to?"]', `fill: ${JSON.stringify(flow.steps[0])}`);
    ok(flow.steps[3].text === 'No filters', 'check text');
    const spec = fs.readFileSync(path.join(FLOWS(), 'clear-filters.spec.mjs'), 'utf8');
    ok(spec.includes("toContainText(\"No filters\")") && spec.includes('@playwright/test'), 'spec');
    const r = await until(async () => {
      const f = await flowOn('main', 'clear-filters');
      return f && (f.status === 'pass' || f.status === 'fail') ? f : false;
    }, 'replayed on main', 120000);
    ok(r.status === 'pass', `passes on main (${r.error})`);
  });

  await step('Watch plays the flow on the page, step by step', async () => {
    await page.keyboard.press('f');
    await page.locator('orch-dock .flow-row').click();
    await page.locator('orch-dock .pop button', { hasText: 'Watch' }).click();
    const bar = page.locator('orch-dock .rec.watch');
    await bar.waitFor({ timeout: 15000 });
    await until(async () => /step 2 of 4/.test(await bar.textContent()), 'shows its progress', 15000, 50);
    await page.screenshot({ path: path.join(SHOTS, '02-watching.png') });
    await until(async () => /passed/.test(await bar.textContent()), 'watch finishes', 30000);
    ok((await page.locator('.search-input').inputValue()) === 'Lisbon', 'it typed into the page');
    ok((await page.locator('.none').count()) === 1, 'it clicked Clear filters');
    ok((await dock().count()) === 0, 'the dock steps aside while watching');
    await bar.getByRole('button', { name: 'Close' }).click();
    await dock().waitFor();
  });

  await step("a take that keeps the flow working passes it, even with the button's text changed", async () => {
    await apiCall('takes', { prompt: 'make the search bar larger' });
    await waitReady('t1');
    const r = await until(async () => {
      const f = await flowOn('t1', 'clear-filters');
      return f && (f.status === 'pass' || f.status === 'fail') ? f : false;
    }, 'replayed on agent-1', 60000);
    ok(r.status === 'pass', `passes on agent-1 (${r.error})`);
    ok(git('show', 'orch/take-1:src/SearchBar.jsx').includes('Search big 1'), 'the take did change the button');
  });

  await step('a take that breaks the flow gets a badge, a notice and a screenshot', async () => {
    await apiCall('takes', { prompt: 'break the clear button' });
    await waitReady('t2');
    const r = await until(async () => {
      const f = await flowOn('t2', 'clear-filters');
      return f && f.status === 'fail' ? f : false;
    }, 'fails on agent-2', 60000);
    ok(!r.alsoOnMain, 'main still passes, so agent-2 broke it');
    ok(r.failedStep === 4 || /Page error/.test(r.error), `points at the problem (${r.error})`);
    ok(/agent-2: flow "Clear filters" failed/.test(orchOut), 'logged');
    await until(async () => (await tile('agent-2').getAttribute('aria-label')).includes('flow broken'), 'tile shows the broken flow');
    const shot = await fetch(`${URL0}__orch/api/flowshot/t2/clear-filters?t=${TOKEN}`);
    ok(shot.status === 200 && shot.headers.get('content-type') === 'image/png', 'screenshot served');
    await tile('agent-2').click();
    await page.waitForLoadState('load');
    await dock().waitFor();
    await page.keyboard.press('f');
    await page.locator('orch-dock .flow.fail').waitFor();
    await page.locator('orch-dock .flow-row').click();
    await page.locator('orch-dock .ferr').first().waitFor();
    await page.screenshot({ path: path.join(SHOTS, '03-broken.png') });
    await page.keyboard.press('Escape');
  });

  await step('Watch on the broken take stops at the failing step', async () => {
    await page.keyboard.press('f');
    await page.locator('orch-dock .flow-row').click();
    await page.locator('orch-dock .pop button', { hasText: 'Watch' }).click();
    const bar = page.locator('orch-dock .rec.watch');
    await bar.waitFor({ timeout: 15000 });
    await until(async () => /failed at step 4/.test(await bar.textContent()), 'watch shows the failure', 30000);
    await page.screenshot({ path: path.join(SHOTS, '04-watch-failed.png') });
    await bar.getByRole('button', { name: 'Close' }).click();
    await dock().waitFor();
  });

  await step('Fix sends the broken flow to the agent, and the flow passes again', async () => {
    const r = await apiCall('takes/t2/fix', {});
    ok(r.status === 200, `fix accepted (${JSON.stringify(r.body)})`);
    const call = await until(() => mockCalls().find((c) => c.prompt.includes('recorded these flows')), 'fix prompt sent');
    ok(call.prompt.includes('Clear filters') && call.prompt.includes('No filters'), 'the prompt has the flow and its steps');
    await waitReady('t2');
    const f = await until(async () => {
      const x = await flowOn('t2', 'clear-filters');
      return x && x.status === 'pass' ? x : false;
    }, 'passes after the fix', 60000);
    ok(f.status === 'pass', 'fixed');
    await until(async () => !(await tile('agent-2').getAttribute('aria-label')).includes('flow'), 'badge cleared');
  });

  await step('deleting a flow removes both files', async () => {
    const r = await apiCall('flows/clear-filters/delete', {});
    ok(r.status === 200, 'deleted');
    ok(!fs.existsSync(path.join(FLOWS(), 'clear-filters.json')) && !fs.existsSync(path.join(FLOWS(), 'clear-filters.spec.mjs')), 'files gone');
    ok((await apiCall('state')).body.flows.length === 0, 'no flows left');
  });

  await step('orch stops cleanly', async () => {
    await stopOrch();
    ok(/Stopping dev servers/.test(orchOut), 'clean shutdown');
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'orch.js'), 'clean', '--yes'], { cwd: APP, env: { ...process.env, ORCH_HOME: HOME } });
  });

  const unexpected = pageErrors.filter((m) => !/undefined|map|length/i.test(m));
  ok(unexpected.length === 0, `no unexpected page errors: ${unexpected.join(' | ')}`);
  console.log(`\nAll ${passed} flow steps passed. Screenshots in ${SHOTS}`);
} finally {
  await shutdown();
}
