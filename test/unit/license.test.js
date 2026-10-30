import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { License, maskKey } from '../../src/license.js';
import { UserError } from '../../src/proc.js';

const DAY = 24 * 60 * 60 * 1000;

/** A fake Polar: routes is { action: (body) => [status, json] }. */
function polar(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const action = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ action, body });
    if (!routes[action]) throw new Error('offline');
    const [status, json] = routes[action](body);
    return { status, text: async () => (json === undefined ? '' : JSON.stringify(json)) };
  };
  return { fetch, calls };
}

function setup(routes, { now = () => 1_000 * DAY } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-license-'));
  const p = polar(routes);
  const make = () => new License({ home, org: 'org-1', api: 'https://polar.test/keys', now, fetch: p.fetch });
  return { home, p, make };
}

test('activate stores a granted key, sends the org, and turns Pro on', async () => {
  const { home, p, make } = setup({
    activate: () => [200, { id: 'act-1', license_key: { status: 'granted', expires_at: null } }],
  });
  const lic = make();
  assert.equal(lic.active, false);
  const info = await lic.activate('  RETAKES-ABCD-1234  ');
  assert.equal(info.active, true);
  assert.equal(info.key, 'RETA…1234');
  assert.equal(p.calls[0].body.organization_id, 'org-1');
  assert.equal(p.calls[0].body.key, 'RETAKES-ABCD-1234');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'license.json'), 'utf8'));
  assert.equal(saved.activationId, 'act-1');
  assert.equal(make().active, true, 'a new process reads the saved key');
});

test('keys without activations fall back to validate', async () => {
  const { p, make } = setup({
    activate: () => [403, { detail: 'License key does not support activations' }],
    validate: () => [200, { status: 'granted', expires_at: null }],
  });
  const lic = make();
  assert.equal((await lic.activate('KEY-00001111')).active, true);
  assert.deepEqual(p.calls.map((c) => c.action), ['activate', 'validate']);
  assert.equal(lic.data.activationId, null);
});

test('activate refuses unknown, revoked and maxed-out keys with a readable error', async () => {
  await assert.rejects(setup({ activate: () => [404, { detail: 'Not found' }] }).make().activate('nope-nope-nope'), UserError);
  await assert.rejects(
    setup({ activate: () => [403, { detail: 'License key activation limit already reached' }] }).make().activate('KEY-00001111'),
    /limit/
  );
  await assert.rejects(
    setup({ activate: () => [200, { id: 'a', license_key: { status: 'revoked' } }] }).make().activate('KEY-00001111'),
    /revoked/
  );
  await assert.rejects(setup({}).make().activate(''), UserError);
});

test('Pro survives a week offline, then turns off until it can check again', async () => {
  let t = 1_000 * DAY;
  const { make } = setup({ activate: () => [200, { id: 'a', license_key: { status: 'granted' } }] }, { now: () => t });
  const lic = make();
  await lic.activate('KEY-00001111');
  t += 2 * DAY;
  await lic.refresh(); // validate isn't routed, so this is offline
  assert.equal(lic.active, true);
  t += 6 * DAY;
  assert.equal(lic.active, false);
});

test('refresh turns Pro off for a revoked or deleted key, and skips the network inside a day', async () => {
  let t = 1_000 * DAY;
  let answer = [200, { status: 'granted' }];
  const { p, make } = setup(
    { activate: () => [200, { id: 'a', license_key: { status: 'granted' } }], validate: () => answer },
    { now: () => t }
  );
  const lic = make();
  await lic.activate('KEY-00001111');
  await lic.refresh();
  assert.equal(p.calls.length, 1, 'checked less than a day ago');
  t += DAY + 1;
  answer = [200, { status: 'revoked' }];
  assert.equal((await lic.refresh()).active, false);
  answer = [404, { detail: 'Not found' }];
  await lic.refresh({ force: true });
  assert.equal(lic.data.status, 'revoked');
});

test('a key past its expiry date is not active', async () => {
  const { make } = setup({ activate: () => [200, { id: 'a', license_key: { status: 'granted', expires_at: new Date(500 * DAY).toISOString() } }] });
  const lic = make();
  const info = await lic.activate('KEY-00001111');
  assert.equal(info.active, false);
});

test('deactivate frees the activation and forgets the key', async () => {
  const { home, p, make } = setup({
    activate: () => [200, { id: 'act-9', license_key: { status: 'granted' } }],
    deactivate: () => [204, undefined],
  });
  const lic = make();
  await lic.activate('KEY-00001111');
  let changed = 0;
  lic.onChange(() => changed++);
  assert.equal(await lic.deactivate(), true);
  assert.equal(p.calls.at(-1).body.activation_id, 'act-9');
  assert.equal(fs.existsSync(path.join(home, 'license.json')), false);
  assert.equal(lic.active, false);
  assert.equal(changed, 1);
  assert.equal(await lic.deactivate(), false);
});

test('without a Polar organization, keys cannot be checked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-license-'));
  await assert.rejects(new License({ home, org: '' }).activate('KEY-00001111'), /organization/);
});

test('maskKey keeps only the ends', () => {
  assert.equal(maskKey('ABCDEFGHIJKL'), 'ABCD…IJKL');
  assert.equal(maskKey('short'), '••••');
});
