/**
 * Names shared by the construct that creates the table, the service that reads it and the tests that create it in
 * DynamoDB Local. Changing one here changes all three.
 */
export const TABLE_KEYS = { pk: 'PK', sk: 'SK' } as const;

/** Board view: cards by project and column, and the list of projects and agents. */
export const GSI1 = { name: 'GSI1', pk: 'GSI1PK', sk: 'GSI1SK' } as const;

/** Repo view: cards by repo. */
export const GSI2 = { name: 'GSI2', pk: 'GSI2PK', sk: 'GSI2SK' } as const;

/** Attention view: cards a given agent was last on that a human has moved back or written to since. Sparse. */
export const GSI3 = { name: 'GSI3', pk: 'GSI3PK', sk: 'GSI3SK' } as const;

/** Epoch seconds; only idempotency items and revoked-token tombstones carry it. */
export const TTL_ATTRIBUTE = 'ttl';

/** Every API path starts here; CloudFront sends `/api/*` to the API. */
export const API_ROOT = '/api';

/** Routes behind the Cognito JWT authorizer. */
export const HUMAN_PREFIX = `${API_ROOT}/human`;

/** Routes behind the bearer-token Lambda authorizer. */
export const AGENT_PREFIX = `${API_ROOT}/agent`;

/** How long a claim lasts without a heartbeat, in minutes, unless the construct is told otherwise. */
export const LEASE_MINUTES_DEFAULT = 10;

/** How often agents are asked to send a heartbeat, in seconds, unless the construct is told otherwise. */
export const HEARTBEAT_SECONDS_DEFAULT = 60;

/** Set to `1` on the Lambda when the construct turns on the board's custom metrics. */
export const METRICS_ENV = 'BATON_METRICS';

/** The environment variables the construct sets on the Lambda and the service reads back. */
export const TIMING_ENV = { leaseMinutes: 'BATON_LEASE_MINUTES', heartbeatSeconds: 'BATON_HEARTBEAT_SECONDS' } as const;

/** What is wrong with a lease and heartbeat pair, if anything: a heartbeat has to arrive before the lease it renews ends. */
export function timingProblem(leaseMinutes: number, heartbeatSeconds: number): string | undefined {
  return heartbeatSeconds >= leaseMinutes * 60 ? 'heartbeatSeconds must be shorter than the lease' : undefined;
}
