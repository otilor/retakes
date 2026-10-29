// Make a throwaway copy of the fixture app: its own git repo with one commit and installed deps.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..', '..');

export function makeApp({ base = process.env.ORCH_E2E_DIR || path.join(os.tmpdir(), 'orch-e2e'), config, fixture = 'app', env = 'VITE_GREETING=hello from env\n' } = {}) {
  const FIXTURE = path.join(ROOT, 'test', 'fixtures', fixture);
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'app-'));
  fs.cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  fs.writeFileSync(path.join(dir, '.env.local'), env);
  if (config) fs.writeFileSync(path.join(dir, 'orch.config.json'), JSON.stringify(config, null, 2));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  if (config) fs.appendFileSync(path.join(dir, '.gitignore'), 'orch.config.json\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: dir, stdio: 'pipe' });
  // Commit the lockfile so takes install with `npm ci`, like a real project.
  git('add', '-A');
  git('commit', '-q', '-m', 'Add lockfile');
  return { dir, git };
}
