// What the current git checkout says about where the work happens.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class CliError extends Error {
  readonly code: string;
  readonly exit: number;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, exit = 2, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.extra = extra;
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** `owner/name`, lower-case, from an origin URL, an scp-style remote or a bare slug. Mirrors the service's rule. */
export function normalizeRepo(input: string): string {
  let path = input.trim();
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(path);
  if (scp) path = scp[1] as string;
  else if (path.includes('://')) path = new URL(path).pathname;
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = path.split('/').filter(Boolean);
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name) throw new CliError('no_remote', `Cannot read owner/name from the remote "${input}".`);
  return `${owner}/${name}`.toLowerCase();
}

export interface Checkout {
  repo: string;
  /** Absolute path of the working tree. */
  worktree: string;
  branch: string;
}

export const notACheckout = (cwd: string): CliError =>
  new CliError(
    'not_a_checkout',
    `${cwd} is not inside a git checkout. Run baton from the repository you are working in.`,
  );

export async function detectCheckout(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Checkout> {
  const worktree = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!worktree) throw notACheckout(cwd);
  let remote = env.BATON_REPO ?? (await git(cwd, ['remote', 'get-url', 'origin']));
  if (!remote) {
    const first = (await git(cwd, ['remote']))?.split('\n')[0];
    remote = first ? await git(cwd, ['remote', 'get-url', first]) : undefined;
  }
  if (!remote) {
    throw new CliError(
      'no_remote',
      'This checkout has no remote, so the board cannot tell which repository it is. Add an origin remote, or set BATON_REPO=owner/name.',
    );
  }
  let branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '';
  if (!branch || branch === 'HEAD') {
    const sha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
    branch = sha ? `detached-${sha}` : 'unborn';
  }
  return { repo: normalizeRepo(remote), worktree, branch };
}

/** Where this worktree keeps the card it holds (linked worktrees each have their own), and the worktree itself. */
export interface Located {
  statePath: string;
  worktree: string;
}

/** What the hooks and the verbs that only name a worktree need from git: no remote required. */
export async function stateFile(cwd: string): Promise<Located | undefined> {
  const worktree = await git(cwd, ['rev-parse', '--show-toplevel']);
  const statePath = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'baton-card']);
  return worktree && statePath ? { statePath, worktree } : undefined;
}
