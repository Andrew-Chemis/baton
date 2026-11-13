// The Lambda behind a plain HTTP server, for the CLI tests, the browser check and local development. It does what API
// Gateway does in front of the function: runs the token authorizer for /api/agent, attaches a stand-in identity for
// /api/human (there is no Cognito here), and serves the built web app with the same security headers the edge adds.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { text } from 'node:stream/consumers';
import { CONTENT_SECURITY_POLICY } from '../../src/csp.ts';
import { AGENT_PREFIX, HUMAN_PREFIX } from '../../src/schema.ts';
import { authorize, handleHttp, type HttpEvent } from '../../service/router.ts';
import type { Deps } from '../../service/store.ts';
import { httpEvent } from './http-event.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface LocalServerOptions {
  deps: Deps;
  port?: number;
  /** Directory of the built web app. Omit to serve the API only. */
  webRoot?: string;
  /** Who people are, since there is no sign-in. */
  humanEmail?: string;
}

export interface LocalServer {
  url: string;
  close: () => Promise<void>;
  server: Server;
}

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const { deps } = options;
  const email = options.humanEmail ?? 'owner@example.test';
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith(`${HUMAN_PREFIX}/`) || url.pathname.startsWith(`${AGENT_PREFIX}/`)) {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
        const body = await text(req);
        const human = url.pathname.startsWith(`${HUMAN_PREFIX}/`);
        const authorizer: HttpEvent['requestContext']['authorizer'] = human
          ? { jwt: { claims: { sub: 'local-user', email, 'cognito:groups': '[admins]' } } }
          : headers.authorization
            ? { lambda: (await authorize(deps, { type: 'REQUEST', routeArn: 'local', headers })).context }
            : undefined;
        const event = httpEvent(req.method ?? 'GET', `${url.pathname}${url.search}`, {
          headers,
          body: body || undefined,
          authorizer,
        });
        const out = await handleHttp(deps, event);
        res.writeHead(out.statusCode, out.headers);
        res.end(out.body);
        return;
      }
      if (!options.webRoot) {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname === '/config.json') {
        // No `cognito` entry: the app runs without sign-in and the API stand-in above supplies the identity.
        res.writeHead(200, { 'content-type': TYPES['.json'] as string, 'cache-control': 'no-store' });
        res.end(JSON.stringify({ apiUrl: '/api' }));
        return;
      }
      const wanted = normalize(join(options.webRoot, url.pathname));
      const isFile = wanted.startsWith(options.webRoot) && existsSync(wanted) && statSync(wanted).isFile();
      // Extension-less paths are client-side routes, as the edge's rewrite function treats them.
      const file = isFile ? wanted : join(options.webRoot, 'index.html');
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': CONTENT_SECURITY_POLICY,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(file));
    })().catch((error: unknown) => {
      console.error('local server error', error instanceof Error ? error.message : String(error));
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
  };
}
