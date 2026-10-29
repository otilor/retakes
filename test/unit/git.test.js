import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitAll, addWorktree, removeWorktree, mergeBranch, branchExists, changedFiles, untrackedInTheWay } from '../../src/git.js';
import { findPort, releasePort, Tail, stripAnsi } from '../../src/proc.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env.local\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

test('commitAll leaves out copied files, ignored or not', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=1\n'); // ignored by .gitignore
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=2\n'); // not ignored
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const sha = await commitAll(dir, 'change', ['.env.local', '.env']);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.txt']);
  assert.equal(await commitAll(dir, 'nothing', ['.env.local', '.env']), null);
});

test('a take branch merges back with a merge commit and cleans up', async () => {
  const { dir, git } = repo();
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-wt-')), 't1');
  await addWorktree(dir, wt, 'retakes/take-1', 'HEAD');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n');
  await commitAll(wt, 'take 1');
  assert.deepEqual(await changedFiles(dir, 'main', 'retakes/take-1'), ['b.txt']);
  await mergeBranch(dir, 'retakes/take-1', 'Keep agent-1');
  assert.equal(git('log', '-1', '--format=%s'), 'Keep agent-1');
  assert.equal(git('rev-list', '--count', '--merges', 'HEAD'), '1');
  await removeWorktree(dir, wt, 'retakes/take-1');
  assert.equal(fs.existsSync(wt), false);
  assert.equal(await branchExists(dir, 'retakes/take-1'), false);
});

test('a conflicting merge is aborted and leaves the checkout clean', async () => {
  const { dir, git } = repo();
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-wt-')), 't1');
  await addWorktree(dir, wt, 'retakes/take-1', 'HEAD');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'take\n');
  await commitAll(wt, 'take 1');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  git('commit', '-q', '-am', 'main edit');
  await assert.rejects(mergeBranch(dir, 'retakes/take-1', 'Keep agent-1'));
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'main\n');
  await removeWorktree(dir, wt, 'retakes/take-1');
});

test('findPort never hands out the same port twice, even when asked at once', async () => {
  const ports = await Promise.all([findPort(47100), findPort(47100), findPort(47100)]);
  assert.equal(new Set(ports).size, 3);
  ports.forEach(releasePort);
});

test('Tail keeps the last lines across chunk boundaries', () => {
  const t = new Tail(2);
  t.push('one\ntw');
  t.push('o\nthree\nfour');
  assert.equal(t.text(), 'three\nfour');
  assert.equal(stripAnsi('\u001b[32mready\u001b[39m'), 'ready');
});

test('Keep merges over an identical untracked file a dev server wrote, but never a different one', async () => {
  const { dir, git } = repo();
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retakes-wt-')), 't1');
  await addWorktree(dir, wt, 'retakes/take-1', 'HEAD');
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), 'generated\n');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n');
  await commitAll(wt, 'take 1');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'mine, different\n');
  await assert.rejects(mergeBranch(dir, 'retakes/take-1', 'Keep agent-1'), /overwritten/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'mine, different\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'generated\n');
  await mergeBranch(dir, 'retakes/take-1', 'Keep agent-1');
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'generated\n');
  assert.equal(git('status', '--porcelain'), '');
  await removeWorktree(dir, wt, 'retakes/take-1');
  assert.deepEqual(untrackedInTheWay('error: The following untracked working tree files would be overwritten by merge:\n\tAGENTS.md\n\tx/y.md\nPlease move or remove them before you merge.'), ['AGENTS.md', 'x/y.md']);
});
