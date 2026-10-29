import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFlow, saveFlow, loadFlows, deleteFlow, playwrightSpec, describeStep, flowId } from '../../src/flows.js';
import { fixPrompt } from '../../src/prompt.js';
import { UserError } from '../../src/proc.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orch-flows-'));
const FLOW = {
  name: 'Clear filters',
  start: '/',
  steps: [
    { do: 'fill', target: ['input[aria-label="Where to?"]'], label: '"Where to?" field', value: 'Lisbon' },
    { do: 'press', target: ['input[aria-label="Where to?"]'], key: 'Enter' },
    { do: 'click', target: ['role=button[name="Clear filters"]', 'body > div > button'], label: '"Clear filters" button' },
    { do: 'expectText', target: ['body > div > span'], label: 'span.none', text: 'No filters' },
  ],
};

test('validateFlow keeps only what replay understands and rejects bad steps', () => {
  const f = validateFlow({ ...FLOW, extra: 1, start: 'http://evil.example/', steps: [{ ...FLOW.steps[0], junk: true }] });
  assert.deepEqual(f, { name: 'Clear filters', start: '/', steps: [{ do: 'fill', target: ['input[aria-label="Where to?"]'], label: '"Where to?" field', value: 'Lisbon' }] });
  assert.equal(validateFlow({ ...FLOW, steps: [{ do: 'press', target: ['x'], key: 'Enter; rm -rf' }] }).steps[0].key, 'Enter');
  for (const bad of [null, { ...FLOW, name: ' ' }, { ...FLOW, steps: [] }, { ...FLOW, steps: [{ do: 'eval', target: ['x'] }] }, { ...FLOW, steps: [{ do: 'click', target: [] }] }, { ...FLOW, steps: [{ do: 'expectText', target: ['x'], text: ' ' }] }]) {
    assert.throws(() => validateFlow(bad), UserError);
  }
});

test('saveFlow writes JSON and a Playwright test, never overwriting another flow by name', () => {
  const dir = tmp();
  const a = saveFlow(dir, FLOW);
  assert.equal(a.id, 'clear-filters');
  const b = saveFlow(dir, FLOW);
  assert.equal(b.id, 'clear-filters-2');
  assert.ok(fs.existsSync(path.join(dir, '.orch', 'flows', 'clear-filters.spec.mjs')));
  // Re-saving by id updates in place.
  saveFlow(dir, { ...FLOW, id: 'clear-filters', name: 'Clear filters again' });
  fs.writeFileSync(path.join(dir, '.orch', 'flows', 'broken.json'), '{ nope');
  assert.deepEqual(loadFlows(dir).map((f) => [f.id, f.name]), [['clear-filters-2', 'Clear filters'], ['clear-filters', 'Clear filters again']]);
  deleteFlow(dir, '../clear-filters-2');
  assert.deepEqual(loadFlows(dir).map((f) => f.id), ['clear-filters']);
  assert.equal(fs.existsSync(path.join(dir, '.orch', 'flows', 'clear-filters-2.spec.mjs')), false);
  assert.equal(flowId('Search → open a stay!'), 'search-open-a-stay');
});

test('playwrightSpec is a runnable test with each step', () => {
  const spec = playwrightSpec(validateFlow(FLOW));
  assert.match(spec, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(spec, /await page\.goto\("\/"\);/);
  assert.match(spec, /\.fill\("Lisbon"\);/);
  assert.match(spec, /\.press\("Enter"\);/);
  assert.match(spec, /page\.locator\("role=button\[name=\\"Clear filters\\"\]"\)\.first\(\)\.click\(\);/);
  assert.match(spec, /toContainText\("No filters"\)/);
});

test('describeStep reads like an instruction', () => {
  assert.deepEqual(validateFlow(FLOW).steps.map(describeStep), [
    'type "Lisbon" into "Where to?" field',
    'press Enter in input[aria-label="Where to?"]',
    'click "Clear filters" button',
    'check span.none says "No filters"',
  ]);
});

test('fixPrompt includes broken flows with the failing step marked', () => {
  const p = fixPrompt([], [{ name: 'Clear filters', start: '/', steps: ['type "Lisbon"', 'click "Clear filters" button'], failedStep: 2, error: 'Step 2: Couldn\'t find it', problems: ['Page error: boom'] }]);
  assert.match(p, /pass on the original version but fail on yours/);
  assert.match(p, /2\. click "Clear filters" button {3}<- failed here/);
  assert.match(p, /Also: Page error: boom/);
  assert.doesNotMatch(p, /errors in the browser/);
});
