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
import { METRICS_ENV } from '../src/schema.ts';
import { createDocClient, type Deps } from './store.ts';
import { runMigrations } from './migrations.ts';
import { createTelemetry } from './telemetry.ts';

let cached: Deps | undefined;

function deps(): Deps {
  cached ??= {
    db: createDocClient(),
    config: configFromEnv(),
    now: Date.now,
    telemetry: createTelemetry({ metrics: process.env[METRICS_ENV] === '1' }),
  };
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

/** A CloudFormation custom resource event, as the provider framework passes it on. */
interface MigrateEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}

/**
 * The migration function's entry: the same bundle, a second handler. On create and update it brings the table to the latest
 * schema; on delete it does nothing, because the data outlives the resource.
 */
export async function migrate(
  event: MigrateEvent,
): Promise<{ PhysicalResourceId: string; Data: Record<string, string> }> {
  const physical = event.PhysicalResourceId ?? 'baton-schema';
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physical, Data: {} };
  const result = await runMigrations(deps());
  console.info('migrations', result);
  return { PhysicalResourceId: physical, Data: { version: String(result.to) } };
}
