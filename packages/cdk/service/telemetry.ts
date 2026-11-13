// One structured line per request, and, when the construct turns them on, a few board metrics in CloudWatch's embedded
// metric format. Both go straight to stdout: the Lambda's JSON log format wraps `console.*` calls in an envelope of its own,
// and CloudWatch reads an embedded metric document only when it is the whole line.
//
// What a line never holds: request or response bodies, headers, tokens, or a person's email. A person is logged by their
// Cognito `sub`; an agent by its id, which the board's owner chose.
import type { ActorKind } from './api-types.ts';

/** Board events worth a metric. Each is one custom metric with no dimensions, so the set's monthly cost stays fixed. */
export type BoardMetric = 'ClaimGranted' | 'ClaimRefused' | 'ClaimTakenOver' | 'ServerError';

export interface RequestLine {
  requestId: string | undefined;
  method: string;
  /** The route's template, e.g. `POST /cards/:id/claim`: never the concrete path, which carries card ids. */
  route: string | undefined;
  status: number;
  code: string | undefined;
  durationMs: number;
  actor: { kind: ActorKind; id: string } | undefined;
  metrics: BoardMetric[];
}

interface LastClaim {
  endedAt: number;
  endedBy: string;
}

export type Sink = (line: string) => void;

export const stdoutSink: Sink = (line) => {
  process.stdout.write(`${line}\n`);
};

export const METRIC_NAMESPACE = 'Baton';

export interface Telemetry {
  request: (line: RequestLine) => void;
}

/** `metrics` false keeps the line and drops the embedded metric block, so nothing is billed as a custom metric. */
export function createTelemetry(options: { sink?: Sink; metrics?: boolean } = {}): Telemetry {
  const sink = options.sink ?? stdoutSink;
  return {
    request: ({ metrics, ...line }) => {
      const record: Record<string, unknown> = {
        level: line.status >= 500 ? 'ERROR' : line.status >= 400 ? 'WARN' : 'INFO',
        msg: 'request',
        ...line,
      };
      if (options.metrics && metrics.length > 0) {
        // The embedded metric format names its block `_aws`.
        // oxlint-disable-next-line eslint/no-underscore-dangle
        record._aws = {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [[]],
              Metrics: metrics.map((Name) => ({ Name, Unit: 'Count' })),
            },
          ],
        };
        for (const name of metrics) record[name] = 1;
      }
      sink(JSON.stringify(record));
    },
  };
}

/** Which metrics a finished request counts toward. */
export function metricsOf(
  route: string | undefined,
  status: number,
  code: string | undefined,
  body: unknown,
): BoardMetric[] {
  const out: BoardMetric[] = [];
  if (status >= 500) out.push('ServerError');
  if (route === 'POST /cards/:id/claim') {
    if (code === 'claim_held') out.push('ClaimRefused');
    const claimed = body as
      | { alreadyHeld?: boolean; card?: { claim?: { claimedAt: number } | null; lastClaim?: LastClaim | null } }
      | undefined;
    if (status === 200 && claimed && !claimed.alreadyHeld) {
      out.push('ClaimGranted');
      // A takeover ends the stale claim at the moment the new one starts; an older takeover has an earlier end.
      const last = claimed.card?.lastClaim;
      if (last?.endedBy === 'taken_over' && last.endedAt === claimed.card?.claim?.claimedAt) out.push('ClaimTakenOver');
    }
  }
  return out;
}
