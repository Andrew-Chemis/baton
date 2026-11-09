// Downloads a pinned DynamoDB Local, checks its SHA-256 and runs it. Tests use the real conditional-write and transaction
// semantics of DynamoDB, so there is no fake to drift from it. Needs Java 17 or later and `curl`.
//   node scripts/dynamodb-local.ts start [--port 8000]   start detached, print the endpoint, exit
//   node scripts/dynamodb-local.ts run   [--port 8000]   run in the foreground until interrupted
// Library use: startDynamoDbLocal() picks a free port and returns the endpoint and a stop function.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { hash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');

/** The release this repository is tested against. AWS publishes dated tarballs under v2.x/; bump all three fields together. */
export const DYNAMODB_LOCAL = {
  version: '3.3.2',
  file: 'dynamodb_local_2026-10-14.tar.gz',
  url: 'https://s3.us-west-2.amazonaws.com/dynamodb-local/v2.x/dynamodb_local_2026-10-14.tar.gz',
  sha256: '7a94eb65f81aee270738751a4e5e3e6a7ad02a5d25194f55b83e08ec2ba6342b',
} as const;

const sha256File = (file: string) => hash('sha256', readFileSync(file));

/** Downloads and unpacks the pinned tarball once; returns the directory holding DynamoDBLocal.jar. */
export function ensureDynamoDbLocal(): string {
  const base = process.env.BATON_CACHE_DIR ?? join(root, '.cache');
  const dir = join(base, 'dynamodb-local', DYNAMODB_LOCAL.version);
  if (existsSync(join(dir, 'DynamoDBLocal.jar'))) return dir;
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, DYNAMODB_LOCAL.file);
  // curl, not fetch: it honours HTTPS_PROXY and the CA bundle variables without further setup.
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', `${tarball}.part`, DYNAMODB_LOCAL.url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  renameSync(`${tarball}.part`, tarball);
  const actual = sha256File(tarball);
  if (actual !== DYNAMODB_LOCAL.sha256) {
    rmSync(tarball, { force: true });
    throw new Error(`DynamoDB Local checksum mismatch: expected ${DYNAMODB_LOCAL.sha256}, got ${actual}`);
  }
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  return dir;
}

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });

const accepts = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });

async function waitForPort(port: number, child: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  /* oxlint-disable eslint/no-await-in-loop -- polling: each probe waits for the last */
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`DynamoDB Local exited with code ${child.exitCode} before it listened`);
    if (await accepts(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  /* oxlint-enable eslint/no-await-in-loop */
  throw new Error(`DynamoDB Local did not listen on ${port} within ${timeoutMs} ms`);
}

export interface RunningDynamoDb {
  endpoint: string;
  port: number;
  stop: () => void;
}

export async function startDynamoDbLocal(
  options: { port?: number; detached?: boolean; stdio?: 'ignore' | 'inherit' } = {},
): Promise<RunningDynamoDb> {
  const dir = ensureDynamoDbLocal();
  const port = options.port ?? (await freePort());
  // -inMemory: nothing on disk, and a fresh process is a clean database.
  const child = spawn(
    'java',
    [
      `-Djava.library.path=${join(dir, 'DynamoDBLocal_lib')}`,
      '-jar',
      join(dir, 'DynamoDBLocal.jar'),
      '-inMemory',
      '-port',
      String(port),
    ],
    { cwd: dir, stdio: options.stdio ?? 'ignore', detached: options.detached ?? false },
  );
  child.once('error', () => undefined);
  try {
    await waitForPort(port, child, 60_000);
  } catch (error) {
    child.kill();
    throw error;
  }
  if (options.detached) child.unref();
  return { endpoint: `http://127.0.0.1:${port}`, port, stop: () => void child.kill() };
}

if (import.meta.main) {
  const [command = 'run', ...rest] = process.argv.slice(2);
  const portIndex = rest.indexOf('--port');
  const port = portIndex >= 0 ? Number(rest[portIndex + 1]) : 8000;
  if (command === 'start') {
    const running = await startDynamoDbLocal({ port, detached: true });
    console.log(running.endpoint);
    process.exit(0);
  } else if (command === 'run') {
    const running = await startDynamoDbLocal({ port, stdio: 'inherit' });
    console.log(`DynamoDB Local on ${running.endpoint}`);
    process.on('SIGINT', () => {
      running.stop();
      process.exit(0);
    });
  } else {
    throw new Error('usage: node scripts/dynamodb-local.ts start|run [--port 8000]');
  }
}
