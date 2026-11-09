// The human API: /api/human/*, with the ID token when there is a user pool and without it in local development.
import { idToken, startSignIn } from './auth.ts';
import type { ApiErrorBody, AppConfig } from './types.ts';
import { randomId } from './util.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

let config: AppConfig = { apiUrl: '/api' };
export const setApiConfig = (next: AppConfig): void => {
  config = next;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.cognito) {
    const token = await idToken(config);
    if (!token) {
      await startSignIn(config, location.pathname + location.search);
      throw new ApiError(401, { code: 'unauthorized', message: 'Signing in…' });
    }
    headers.authorization = `Bearer ${token}`;
  }
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = randomId();
  }
  const response = await fetch(`${config.apiUrl}/human${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  if (response.ok) return parsed as T;
  if (response.status === 401 && config.cognito) {
    await startSignIn(config, location.pathname + location.search);
  }
  const error =
    parsed && typeof (parsed as ApiErrorBody).code === 'string'
      ? (parsed as ApiErrorBody)
      : {
          code: 'internal' as const,
          message: `The board answered ${response.status}. Reload the page; if it persists, the API may be down.`,
        };
  throw new ApiError(response.status, error);
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong. Reload the page and try again.';
