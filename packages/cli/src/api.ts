// The HTTP client. Every write carries an Idempotency-Key that stays the same across the retries inside one run, so a request
// whose answer was lost on the way back is answered from the board's record instead of being done twice. A new run makes a new
// key: running `comment`, or `create` without `--key`, again after a lost answer can post twice.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './git.ts';

export interface BoardRefusal {
  status: number;
  body: { code: string; message: string; [key: string]: unknown };
}

/** The board answered, and the answer was no. */
export class BoardError extends CliError {
  readonly status: number;
  constructor(refusal: BoardRefusal) {
    super(refusal.body.code, refusal.body.message, 1, refusal.body);
    this.status = refusal.status;
  }
}

export interface ApiOptions {
  url: string;
  token: string;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Pauses between attempts; one more attempt per entry. */
  backoffMs?: number[] | undefined;
}

export interface Reply<T = Record<string, any>> {
  status: number;
  body: T;
}

const AGENT_ROOT = '/api/agent';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class Api {
  readonly #options: ApiOptions;
  constructor(options: ApiOptions) {
    this.#options = options;
  }

  get<T = Record<string, any>>(path: string, query: Record<string, string | undefined> = {}) {
    return this.#send<T>('GET', path, query, undefined);
  }

  post<T = Record<string, any>>(path: string, body: unknown = {}) {
    return this.#send<T>('POST', path, {}, body);
  }

  async #send<T>(
    method: string,
    path: string,
    query: Record<string, string | undefined>,
    body: unknown,
  ): Promise<Reply<T>> {
    const { url, token } = this.#options;
    const doFetch = this.#options.fetch ?? fetch;
    const sleep = this.#options.sleep ?? ((ms: number) => delay(ms));
    const backoff = this.#options.backoffMs ?? [400, 1200, 3500];
    const target = new URL(`${url}${AGENT_ROOT}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) target.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = randomUUID();
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let lastProblem = '';
    /* oxlint-disable eslint/no-await-in-loop -- each attempt follows the failure of the one before */
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      if (attempt > 0) await sleep(backoff[attempt - 1] as number);
      let response: Response;
      try {
        response = await doFetch(target, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
        continue;
      }
      const text = await response.text();
      if (RETRYABLE.has(response.status) && attempt < backoff.length) {
        lastProblem = `the board answered ${response.status}`;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = undefined;
      }
      if (response.ok) return { status: response.status, body: (parsed ?? {}) as T };
      if (parsed && typeof parsed === 'object' && typeof (parsed as { code?: unknown }).code === 'string') {
        throw new BoardError({ status: response.status, body: parsed as BoardRefusal['body'] });
      }
      throw new BoardError({
        status: response.status,
        body: {
          code: 'bad_response',
          message: `The address answered ${response.status} with something that is not a Baton reply. Check that BATON_URL is the board's https address (no path), and that the token is current.`,
        },
      });
    }
    /* oxlint-enable eslint/no-await-in-loop */
    throw new CliError(
      'unreachable',
      `Could not reach the board at ${url} (${lastProblem}). Retries inside this run reuse one idempotency key, so they never write twice; running the command again starts a new key. If the board may have received the request, look at the card before repeating a \`comment\`, or a \`create\` without \`--key\`, or it can be posted twice. Check BATON_URL and the network, then run the command again.`,
      1,
    );
  }
}
