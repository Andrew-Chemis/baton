// A real board for CLI tests: the Lambda's router over a real table in DynamoDB Local, behind a local HTTP server, with a
// git checkout the CLI can detect. The CLI runs in-process through run(), with the real fetch, against that server.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBoard, type Board } from '../../cdk/test/support/board.ts';
import { startLocalServer, type LocalServer } from '../../cdk/test/support/local-server.ts';
import { run } from '../src/run.ts';

export const REPO = 'acme/widgets';
export const REMOTE = `https://github.com/${REPO}.git`;

export interface Cli {
  code: number;
  stdout: string;
  stderr: string;
  /** The JSON the command printed on stdout, or undefined when it printed none. */
  json: any;
  /** The error object printed on stderr, when there was one. */
  error: any;
}

export interface World {
  board: Board;
  server: LocalServer;
  /** Env that points the CLI at the server with a fresh agent's token. */
  env: Record<string, string>;
  token: string;
  agentId: string;
  dirs: string[];
  /** A fresh clone-like checkout: git init, an origin remote, one commit. */
  repo: (remote?: string | null) => string;
  /** A linked worktree of `main`, on its own branch. */
  worktree: (main: string, branch: string) => string;
  baton: (
    args: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: () => number },
  ) => Promise<Cli>;
  close: () => Promise<void>;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

export async function startWorld(options: { clock?: boolean } = {}): Promise<World> {
  const board = await newBoard();
  const server = await startLocalServer({ deps: board.deps });
  const human = board.as({ human: 'owner@example.test' });
  const agentId = 'tester';
  const created = await human.post('/agents', { name: agentId });
  if (created.status !== 201) throw new Error(`agent: ${JSON.stringify(created.body)}`);
  const issued = await human.post(`/agents/${created.body.agent.id}/tokens`, { label: 'cli tests' });
  const token = issued.body.token as string;
  const dirs: string[] = [];
  void options;

  const world: World = {
    board,
    server,
    env: { BATON_URL: server.url, BATON_TOKEN: token },
    token,
    agentId: created.body.agent.id as string,
    dirs,
    repo(remote = REMOTE) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'baton-repo-')));
      dirs.push(dir);
      git(dir, 'init', '-q', '-b', 'main');
      if (remote) git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
      return dir;
    },
    worktree(main, branch) {
      const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'baton-wt-'))), 'tree');
      dirs.push(join(dir, '..'));
      git(main, 'worktree', 'add', '-q', '-b', branch, dir);
      return dir;
    },
    async baton(args, opts = {}) {
      let stdout = '';
      let stderr = '';
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '',
        HOME: join(tmpdir(), 'baton-no-home'),
        ...world.env,
      };
      for (const [k, v] of Object.entries(opts.env ?? {})) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      const code = await run(args, {
        cwd: opts.cwd ?? tmpdir(),
        env,
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        backoffMs: [1, 1, 1],
      });
      const parse = (s: string) => {
        try {
          return s.trim() ? JSON.parse(s) : undefined;
        } catch {
          return undefined;
        }
      };
      return { code, stdout, stderr, json: parse(stdout), error: parse(stderr)?.error };
    },
    async close() {
      await server.close();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
  return world;
}

export function writeFile(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return file;
}
