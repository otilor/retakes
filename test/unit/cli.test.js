import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../src/cli.js';
import { UserError } from '../../src/proc.js';

test('parseArgs defaults to start and opens the browser', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'start', open: true, yes: false });
});

test('parseArgs reads commands and options', () => {
  assert.deepEqual(parseArgs(['--port', '4400', '--no-open']), { cmd: 'start', open: false, yes: false, port: 4400 });
  assert.equal(parseArgs(['--port=4401']).port, 4401);
  assert.deepEqual(parseArgs(['clean', '-y']), { cmd: 'clean', open: true, yes: true });
  assert.equal(parseArgs(['-h']).cmd, 'help');
  assert.equal(parseArgs(['--version']).cmd, 'version');
});

test('parseArgs rejects bad input with a readable error', () => {
  assert.throws(() => parseArgs(['--port']), UserError);
  assert.throws(() => parseArgs(['--port', 'abc']), UserError);
  assert.throws(() => parseArgs(['--port', '70000']), UserError);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

test('parseArgs takes a model and an effort for new runs', () => {
  const o = parseArgs(['--model', 'opus', '--effort=high']);
  assert.equal(o.model, 'opus');
  assert.equal(o.effort, 'high');
  assert.equal(parseArgs(['--model=claude-sonnet-4-5']).model, 'claude-sonnet-4-5');
  assert.throws(() => parseArgs(['--effort', 'turbo']), /--effort is one of/);
  assert.throws(() => parseArgs(['--model', '--no-open']), UserError);
  assert.throws(() => parseArgs(['--model']), UserError);
});
