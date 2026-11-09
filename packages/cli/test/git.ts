// git for tests: one call everywhere, with an identity so a commit works in a bare environment, and its output trimmed.
import { execFileSync } from 'node:child_process';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

/** Where `dir`'s worktree keeps the card it holds, as the CLI works it out. */
export const stateFileOf = (dir: string): string =>
  git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'baton-card');
