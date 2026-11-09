export interface Config {
  table: string;
  leaseMs: number;
  heartbeatSeconds: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const table = env.BATON_TABLE;
  if (!table) throw new Error('BATON_TABLE is not set');
  const leaseMinutes = Number(env.BATON_LEASE_MINUTES ?? 10);
  const heartbeatSeconds = Number(env.BATON_HEARTBEAT_SECONDS ?? 60);
  if (!(leaseMinutes > 0) || !(heartbeatSeconds > 0)) throw new Error('lease and heartbeat must be positive numbers');
  return { table, leaseMs: Math.round(leaseMinutes * 60_000), heartbeatSeconds };
}
