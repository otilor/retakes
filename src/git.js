import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.js';

export function git(args, cwd) {
  return run('git', args, { cwd });
}

export async function gitOk(args, cwd) {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(cwd) {
  const name = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  return name === 'HEAD' ? null : name;
}

export async function headSha(cwd) {
  return (await git(['rev-parse', 'HEAD'], cwd)).trim();
}

export async function branchExists(cwd, branch) {
  return gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
}

export async function isDirty(cwd) {
  const out = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return out.trim().length > 0;
}

/** Git needs a name and email to commit. Fall back to a local identity if the user has none. */
async function identityArgs(cwd) {
  const email = await git(['config', 'user.email'], cwd).catch(() => '');
  const name = await git(['config', 'user.name'], cwd).catch(() => '');
  const args = [];
  if (!email.trim()) args.push('-c', 'user.email=retakes@localhost');
  if (!name.trim()) args.push('-c', 'user.name=Retakes');
  return args;
}

export async function addWorktree(gitRoot, dir, branch, base) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(['worktree', 'add', '-b', branch, dir, base], gitRoot);
}

export async function removeWorktree(gitRoot, dir, branch) {
  if (fs.existsSync(dir)) {
    await git(['worktree', 'remove', '--force', '--force', dir], gitRoot).catch(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  await git(['worktree', 'prune'], gitRoot).catch(() => {});
  if (branch && (await branchExists(gitRoot, branch))) {
    await git(['branch', '-D', branch], gitRoot);
  }
}

/**
 * Commit everything in a worktree except the files Retakes copied in (like .env).
 * Returns the new commit's sha, or null when there was nothing to commit.
 */
export async function commitAll(worktreeRoot, message, excludePaths = []) {
  // Copied files that git already ignores need no exclusion (and git refuses to name them).
  const exclude = [];
  for (const p of excludePaths) {
    const rel = p.split(path.sep).join('/');
    if (!(await gitOk(['check-ignore', '-q', '--', rel], worktreeRoot))) exclude.push(rel);
  }
  const pathspec = ['.', ...exclude.map((p) => `:(exclude)${p}`)];
  await git(['add', '-A', '--', ...pathspec], worktreeRoot);
  const staged = !(await gitOk(['diff', '--cached', '--quiet'], worktreeRoot));
  if (!staged) return null;
  await git([...(await identityArgs(worktreeRoot)), 'commit', '--no-verify', '-q', '-m', message], worktreeRoot);
  return headSha(worktreeRoot);
}

export async function commitsAhead(cwd, base, branch) {
  const out = await git(['rev-list', '--count', `${base}..${branch}`], cwd);
  return Number(out.trim()) || 0;
}

export async function changedFiles(cwd, base, branch) {
  const out = await git(['diff', '--name-only', `${base}...${branch}`], cwd);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Merge a branch into whatever the main checkout has checked out. Aborts cleanly on conflicts. */
export async function mergeBranch(gitRoot, branch, message) {
  const merge = async () => {
    try {
      await git([...(await identityArgs(gitRoot)), 'merge', '--no-ff', '--no-edit', '-m', message, branch], gitRoot);
    } catch (err) {
      const mergeHead = (await git(['rev-parse', '--git-path', 'MERGE_HEAD'], gitRoot)).trim();
      if (fs.existsSync(path.resolve(gitRoot, mergeHead))) await git(['merge', '--abort'], gitRoot).catch(() => {});
      throw err;
    }
  };
  try {
    await merge();
  } catch (err) {
    // Dev servers write files of their own (Next.js writes AGENTS.md), so the same untracked file
    // can exist in your checkout and be committed on the take. When the contents match, the merge
    // would write exactly what's there, so set them aside, merge, and put them back on failure.
    const files = untrackedInTheWay(err.message);
    if (!files.length) throw err;
    const saved = [];
    for (const rel of files) {
      const abs = path.join(gitRoot, rel);
      const theirs = await git(['show', `${branch}:${rel}`], gitRoot).catch(() => null);
      if (theirs === null || !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== theirs) throw err;
      saved.push([abs, fs.readFileSync(abs)]);
    }
    for (const [abs] of saved) fs.unlinkSync(abs);
    try {
      await merge();
    } catch (err2) {
      for (const [abs, data] of saved) if (!fs.existsSync(abs)) fs.writeFileSync(abs, data);
      throw err2;
    }
  }
}

export function untrackedInTheWay(message) {
  const m = String(message).match(/untracked working tree files would be overwritten by merge:\n([\s\S]*?)\n(Please|Aborting)/);
  return m ? m[1].split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/** Branches Retakes made, from `git worktree list`, so `retakes clean` can find leftovers. */
export async function listWorktrees(gitRoot) {
  const out = await git(['worktree', 'list', '--porcelain'], gitRoot);
  const items = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { dir: line.slice(9), branch: null };
      items.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  return items;
}
