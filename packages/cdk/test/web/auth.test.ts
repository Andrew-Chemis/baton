// Requirement 6.5: the page and every human call need a Cognito sign-in. Hosted UI, code flow with PKCE, tokens refreshed.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AppConfig } from '../../web/src/types.ts';
import { stubApi } from './support.tsx';

const config: AppConfig = { apiUrl: '/api', cognito: { domain: 'https://auth.example.test', clientId: 'client-1' } };
const jwt = (claims: object, expSeconds = 3600) =>
  `h.${btoa(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + expSeconds })).replace(/=+$/, '')}.s`;

let auth: typeof import('../../web/src/auth.ts');
let apiModule: typeof import('../../web/src/api.ts');
// The tokens live in module state as well as in localStorage, so each test gets a fresh copy of both modules.
beforeEach(async () => {
  vi.resetModules();
  auth = await import('../../web/src/auth.ts');
  apiModule = await import('../../web/src/api.ts');
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('sign-in', () => {
  test('sends the browser to the hosted UI with a PKCE challenge and a state it can check later', async () => {
    const to = vi.fn();
    await auth.startSignIn(config, '/p/widgets?card=1', to);
    const url = new URL(to.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe('https://auth.example.test/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(`${location.origin}/auth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const pending = JSON.parse(sessionStorage.getItem('baton.signin') as string);
    expect(url.searchParams.get('state')).toBe(pending.state);
    const expected = createHash('sha256').update(pending.verifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(pending.returnTo).toBe('/p/widgets?card=1');
  });

  test('exchanges the code for tokens and returns where the person was going', async () => {
    const to = vi.fn();
    await auth.startSignIn(config, '/agents', to);
    const state = JSON.parse(sessionStorage.getItem('baton.signin') as string);
    const id = jwt({ email: 'owner@example.test' });
    const calls = stubApi({ 'POST /oauth2/token': { id_token: id, refresh_token: 'r1', expires_in: 3600 } });
    const result = await auth.finishSignIn(config, `?code=abc&state=${state.state}`);
    expect(result).toEqual({ returnTo: '/agents' });
    expect(calls[0]?.path).toBe('/oauth2/token');
    expect(String(calls[0]?.body)).toContain('code=abc');
    expect(auth.signedIn()).toBe(true);
    expect(auth.emailOf()).toBe('owner@example.test');
    expect(await auth.idToken(config)).toBe(id);
  });

  test('the token request is form-encoded with the verifier', async () => {
    await auth.startSignIn(config, '/', vi.fn());
    const pending = JSON.parse(sessionStorage.getItem('baton.signin') as string);
    let sent = '';
    let type = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = init.body as string;
      type = new Headers(init.headers).get('content-type') ?? '';
      return new Response(JSON.stringify({ id_token: jwt({}), expires_in: 3600 }));
    });
    await auth.finishSignIn(config, `?code=the-code&state=${pending.state}`);
    const form = new URLSearchParams(sent);
    expect(type).toBe('application/x-www-form-urlencoded');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toBe(pending.verifier);
    expect(form.get('client_id')).toBe('client-1');
  });

  test('refuses a callback whose state it did not issue', async () => {
    await auth.startSignIn(config, '/', vi.fn());
    const result = await auth.finishSignIn(config, '?code=abc&state=forged');
    expect(result).toMatchObject({ error: expect.stringMatching(/could not be matched/) });
    expect(auth.signedIn()).toBe(false);
  });

  test('reports a refusal from the hosted UI', async () => {
    const result = await auth.finishSignIn(config, '?error=access_denied&error_description=Nope');
    expect(result).toEqual({ error: 'Nope' });
  });

  test('refreshes an expiring token and signs out when the refresh is refused', async () => {
    localStorage.setItem(
      'baton.tokens',
      JSON.stringify({ idToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 10_000 }),
    );
    const fresh = auth;
    let body = '';
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return new Response(JSON.stringify({ id_token: 'new-token', expires_in: 3600 }));
    });
    expect(await fresh.idToken(config)).toBe('new-token');
    expect(new URLSearchParams(body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(body).get('refresh_token')).toBe('r1');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 400 }));
    localStorage.setItem('baton.tokens', JSON.stringify({ idToken: 'old', refreshToken: 'r1', expiresAt: 1 }));
    vi.resetModules();
    const again = await import('../../web/src/auth.ts');
    expect(await again.idToken(config)).toBeNull();
    expect(localStorage.getItem('baton.tokens')).toBeNull();
  });

  test('sign out forgets the tokens and leaves through the hosted UI', async () => {
    localStorage.setItem(
      'baton.tokens',
      JSON.stringify({ idToken: jwt({}), refreshToken: 'r', expiresAt: Date.now() + 1e6 }),
    );
    const to = vi.fn();
    auth.signOut(config, to);
    expect(localStorage.getItem('baton.tokens')).toBeNull();
    const url = new URL(to.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('logout_uri')).toBe(`${location.origin}/`);
  });
});

describe('API calls', () => {
  test('carry the ID token as a bearer, and writes carry an idempotency key', async () => {
    const { api: freshApi, setApiConfig: setFresh } = apiModule;
    localStorage.setItem(
      'baton.tokens',
      JSON.stringify({ idToken: jwt({ email: 'a@b.test' }), refreshToken: null, expiresAt: Date.now() + 1e6 }),
    );
    setFresh(config);
    const calls = stubApi({ 'GET /projects': { projects: [] }, 'POST /cards': { card: {} } });
    await freshApi.get('/projects');
    await freshApi.post('/cards', { title: 'x' });
    expect(calls[0]?.headers.get('authorization')).toMatch(/^Bearer h\./);
    expect(calls[0]?.headers.get('idempotency-key')).toBeNull();
    expect(calls[1]?.headers.get('idempotency-key')).toBeTruthy();
    expect(calls[0]?.path).toBe('/api/human/projects');
    expect(auth.signedIn()).toBe(true);
  });

  test('without a user pool (local development) no token is sent', async () => {
    apiModule.setApiConfig({ apiUrl: '/api' });
    const calls = stubApi({ 'GET /projects': { projects: [] } });
    await apiModule.api.get('/projects');
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  test("a refusal surfaces the board's own message", async () => {
    apiModule.setApiConfig({ apiUrl: '/api' });
    stubApi({
      'POST /projects': new Response(
        JSON.stringify({ code: 'repo_taken', message: 'acme/widgets belongs to Widgets.' }),
        { status: 409 },
      ),
    });
    await expect(apiModule.api.post('/projects', {})).rejects.toMatchObject({
      message: 'acme/widgets belongs to Widgets.',
      status: 409,
    });
  });
});
