// Lambda entry. One function serves every route and the token authorizer: API Gateway invokes it with a proxy event for a
// request and with a REQUEST event for authorization, and the shapes differ.
import { configFromEnv } from './config.ts';
import {
  authorize,
  handleHttp,
  type AuthorizerEvent,
  type HttpEvent,
  type HttpResult,
  type AuthorizerResult,
} from './router.ts';
import { createDocClient, type Deps } from './store.ts';

let cached: Deps | undefined;

function deps(): Deps {
  cached ??= { db: createDocClient(), config: configFromEnv(), now: Date.now };
  return cached;
}

const isAuthorizerEvent = (event: unknown): event is AuthorizerEvent =>
  typeof event === 'object' &&
  event !== null &&
  (event as { type?: unknown }).type === 'REQUEST' &&
  'routeArn' in event;

export async function handler(event: HttpEvent | AuthorizerEvent): Promise<HttpResult | AuthorizerResult> {
  return isAuthorizerEvent(event) ? authorize(deps(), event) : handleHttp(deps(), event);
}
