import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Retakes } from '../../src/retakes.js';
import { setAgentHelp } from '../../src/agent.js';
import { UserError } from '../../src/proc.js';

function project(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-core-'));
  const stateDir = path.join(dir, 'home', 'projects', 'app');
  return { name: 'app', appDir: dir, gitRoot: dir, rel: '', config, stateDir, takesDir: path.join(stateDir, 'takes'), devMode: { kind: 'vite' } };
}

test('new runs use Sonnet on low effort until something else is picked', () => {
  setAgentHelp('  --effort <level>');
  const r = new Retakes(project());
  assert.deepEqual(r.agentChoice(), { model: 'sonnet', effort: 'low' });
  const info = r.snapshot().agent;
  assert.deepEqual(info.models, ['haiku', 'sonnet', 'opus']);
  assert.deepEqual(info.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(info.locked, { model: false, effort: false });
});

test('the config sets the default, the dock pick beats it and is remembered', () => {
  const p = project({ agent: { model: 'haiku', effort: 'medium' } });
  const r = new Retakes(p);
  assert.deepEqual(r.agentChoice(), { model: 'haiku', effort: 'medium' });
  r.setAgent({ model: 'opus' });
  r.setAgent({ effort: 'high' });
  assert.deepEqual(r.agentChoice(), { model: 'opus', effort: 'high' });
  assert.deepEqual(new Retakes(p).agentChoice(), { model: 'opus', effort: 'high' });
  // --model and --effort at start replace the remembered pick.
  assert.deepEqual(new Retakes(p, { agent: { model: 'sonnet', effort: 'max' } }).agentChoice(), { model: 'sonnet', effort: 'max' });
});

test('setAgent rejects anything that is not a model or an effort level', () => {
  const r = new Retakes(project());
  assert.throws(() => r.setAgent({ model: '--dangerously-skip-permissions' }), UserError);
  assert.throws(() => r.setAgent({ model: '' }), UserError);
  assert.throws(() => r.setAgent({ effort: 'turbo' }), UserError);
  assert.throws(() => r.setAgent({ model: 'opus', effort: 'turbo' }), UserError);
  assert.deepEqual(r.agentChoice(), { model: 'sonnet', effort: 'low' });
});

test('a custom model is offered next to the usual ones, and agent.args locks the pickers', () => {
  const r = new Retakes(project({ agent: { model: 'claude-sonnet-4-5', args: ['--effort', 'high'] } }));
  const info = r.snapshot().agent;
  assert.deepEqual(info.models, ['haiku', 'sonnet', 'opus', 'claude-sonnet-4-5']);
  assert.deepEqual(info.locked, { model: false, effort: true });
  assert.equal(info.effort, 'high', 'the locked picker shows what runs really get');
});

test('effort is hidden when this Claude Code has no --effort', () => {
  setAgentHelp('  --model <m>');
  assert.equal(new Retakes(project()).snapshot().agent.efforts, false);
});

test('several takes at once needs Pro, and is capped', async () => {
  const r = new Retakes(project());
  assert.deepEqual(r.snapshot().pro, { active: false, url: 'https://github.com/otilor/retakes#pro', maxBatch: 3 });
  await assert.rejects(r.createTakes({ prompt: 'Bigger button', count: 3 }), /Retakes Pro/);
  const pro = new Retakes(project(), { license: { active: true, onChange: () => () => {} } });
  assert.equal(pro.snapshot().pro.active, true);
  await assert.rejects(pro.createTakes({ prompt: 'Bigger button', count: 4 }), /1 to 3/);
});
