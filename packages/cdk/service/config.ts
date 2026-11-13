import { HEARTBEAT_SECONDS_DEFAULT, LEASE_MINUTES_DEFAULT, TIMING_ENV, timingProblem } from '../src/schema.ts';

export interface Config {
  table: string;
  leaseMs: number;
  heartbeatSeconds: number;
}

/** The deployed defaults for `table`, with any of the timings replaced: what tests and the local server run on. */
export const configFor = (table: string, timing: Partial<Omit<Config, 'table'>> = {}): Config => ({
  table,
  leaseMs: LEASE_MINUTES_DEFAULT * 60_000,
  heartbeatSeconds: HEARTBEAT_SECONDS_DEFAULT,
  ...timing,
});

/** What the API tells an agent about its claim: how long it lasts and how often to renew it. */
export const timingOf = (config: Config) => ({
  leaseSeconds: Math.round(config.leaseMs / 1000),
  heartbeatSeconds: config.heartbeatSeconds,
});

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const table = env.BATON_TABLE;
  if (!table) throw new Error('BATON_TABLE is not set');
  const leaseMinutes = Number(env[TIMING_ENV.leaseMinutes] ?? LEASE_MINUTES_DEFAULT);
  const heartbeatSeconds = Number(env[TIMING_ENV.heartbeatSeconds] ?? HEARTBEAT_SECONDS_DEFAULT);
  if (!(leaseMinutes > 0) || !(heartbeatSeconds > 0)) throw new Error('lease and heartbeat must be positive numbers');
  const problem = timingProblem(leaseMinutes, heartbeatSeconds);
  if (problem) throw new Error(problem);
  return { table, leaseMs: Math.round(leaseMinutes * 60_000), heartbeatSeconds };
}
