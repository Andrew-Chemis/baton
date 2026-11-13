import { describe, expect, test } from 'vitest';
import { configFor, configFromEnv, timingOf } from '../../service/config.ts';

describe('configFromEnv', () => {
  test('defaults to a ten minute lease and a minute between heartbeats, and tells agents so', () => {
    const config = configFromEnv({ BATON_TABLE: 't' });
    expect(config).toEqual({ table: 't', leaseMs: 600_000, heartbeatSeconds: 60, adminGroup: 'admins' });
    expect(config).toEqual(configFor('t'));
    expect(timingOf(config)).toEqual({ leaseSeconds: 600, heartbeatSeconds: 60 });
  });

  test('reads the lease in minutes and the heartbeat in seconds', () => {
    const config = configFromEnv({ BATON_TABLE: 't', BATON_LEASE_MINUTES: '5', BATON_HEARTBEAT_SECONDS: '30' });
    expect(timingOf(config)).toEqual({ leaseSeconds: 300, heartbeatSeconds: 30 });
  });

  test('refuses a missing table, a timing that is not positive, and a heartbeat that outlasts its lease', () => {
    expect(() => configFromEnv({})).toThrow(/BATON_TABLE/);
    expect(() => configFromEnv({ BATON_TABLE: 't', BATON_LEASE_MINUTES: '0' })).toThrow(/positive/);
    expect(() => configFromEnv({ BATON_TABLE: 't', BATON_HEARTBEAT_SECONDS: '-1' })).toThrow(/positive/);
    expect(() => configFromEnv({ BATON_TABLE: 't', BATON_LEASE_MINUTES: '1', BATON_HEARTBEAT_SECONDS: '60' })).toThrow(
      /shorter than the lease/,
    );
  });
});
