// Cognito hosted-UI sign-in: authorization code with PKCE, tokens kept in this browser, refreshed before they expire. The
// API is called with the ID token, which carries the email the board shows as the author of a comment.
import type { AppConfig } from './types.ts';
import { randomId, store } from './util.ts';

interface Tokens {
  idToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

const TOKENS = 'baton.tokens';
const PENDING = 'baton.signin';

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

let memory: Tokens | null = null;

function saved(): Tokens | null {
  if (memory) return memory;
  const raw = store.get(TOKENS);
  if (!raw) return null;
  try {
    memory = JSON.parse(raw) as Tokens;
    return memory;
  } catch {
    return null;
  }
}

function keep(tokens: Tokens | null): void {
  memory = tokens;
  store.set(TOKENS, tokens ? JSON.stringify(tokens) : null);
}

const redirectUri = () => `${location.origin}/auth/callback`;

const go = (url: string): void => location.assign(url);

export async function startSignIn(config: AppConfig, returnTo: string, to: (url: string) => void = go): Promise<void> {
  if (!config.cognito) return;
  const verifier = random(48);
  const state = random(16);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  try {
    sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, returnTo }));
  } catch {
    // Without sessionStorage the sign-in cannot be finished; the callback says so.
  }
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognito.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  to(`${config.cognito.domain}/oauth2/authorize?${query}`);
}

async function tokenRequest(config: AppConfig, form: Record<string, string>): Promise<Tokens | null> {
  if (!config.cognito) return null;
  const response = await fetch(`${config.cognito.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.cognito.clientId, ...form }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { id_token: string; refresh_token?: string; expires_in: number };
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token ?? saved()?.refreshToken ?? null,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

/** Completes the redirect back from the hosted UI. Returns where the person was going, or an error message. */
export async function finishSignIn(
  config: AppConfig,
  search: string,
): Promise<{ returnTo: string } | { error: string }> {
  const params = new URLSearchParams(search);
  if (params.get('error'))
    return { error: params.get('error_description') ?? params.get('error') ?? 'Sign-in was refused.' };
  let pending: { verifier: string; state: string; returnTo: string } | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null');
    sessionStorage.removeItem(PENDING);
  } catch {
    pending = null;
  }
  const code = params.get('code');
  if (!code || !pending || params.get('state') !== pending.state) {
    return { error: 'The sign-in could not be matched to a request from this browser. Start again.' };
  }
  const tokens = await tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  if (!tokens) return { error: 'The sign-in server did not accept the code. Start again.' };
  keep(tokens);
  return { returnTo: pending.returnTo || '/' };
}

/** A token good for at least a minute, refreshed if need be; null means sign in again. */
export async function idToken(config: AppConfig): Promise<string | null> {
  const tokens = saved();
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.idToken;
  if (!tokens.refreshToken) return null;
  const fresh = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  if (!fresh) {
    keep(null);
    return null;
  }
  keep(fresh);
  return fresh.idToken;
}

export const signedIn = (): boolean => saved() !== null;

export function emailOf(): string | null {
  const token = saved()?.idToken;
  if (!token) return null;
  try {
    const payload = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

export function signOut(config: AppConfig, to: (url: string) => void = go): void {
  keep(null);
  if (config.cognito) {
    const query = new URLSearchParams({ client_id: config.cognito.clientId, logout_uri: `${location.origin}/` });
    to(`${config.cognito.domain}/logout?${query}`);
  } else {
    to('/');
  }
}

export { randomId };
