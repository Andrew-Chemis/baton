// Data migrations. The table records the schema version it is at in one item; a deploy runs every migration above it, in
// order, through a CloudFormation custom resource, so new code never meets data shaped for older code for longer than the
// deploy takes.
//
// A migration must be idempotent and safe to run beside live traffic: it rewrites an item only under a condition that the
// item has not changed since it was read, and a card written meanwhile was already written in the new shape, because every
// card write derives its keys afresh (card-model.ts `keyed`).
import { GetCommand, ScanCommand, UpdateCommand, type ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { LATEST_SCHEMA } from '../src/schema-version.ts';
import { keyed } from './card-model.ts';
import type { CardItem } from './items.ts';
import type { Deps } from './store.ts';

export const SCHEMA_KEY = { PK: 'SCHEMA', SK: 'META' } as const;

export interface Migration {
  version: number;
  name: string;
  run: (deps: Deps) => Promise<{ scanned: number; changed: number }>;
}

interface SchemaItem {
  version: number;
  lockedUntil?: number;
  history?: { version: number; name: string; at: number; scanned: number; changed: number }[];
}

const INDEX_ATTRIBUTES = ['GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'GSI3PK', 'GSI3SK'] as const;
const LOCK_MS = 15 * 60 * 1000;

/** Every item a scan returns, page by page, filtered. */
async function scanAll(
  deps: Deps,
  input: Omit<ScanCommandInput, 'TableName'>,
  each: (item: CardItem) => Promise<void>,
) {
  let startKey: Record<string, unknown> | undefined;
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the previous page's key
    const out = await deps.db.send(
      new ScanCommand({ ...input, TableName: deps.config.table, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }),
    );
    for (const item of (out.Items ?? []) as CardItem[]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one conditional write at a time keeps the table's load flat
      await each(item);
    }
    startKey = out.LastEvaluatedKey;
  } while (startKey);
}

const isConditionFailure = (error: unknown) => (error as { name?: string }).name === 'ConditionalCheckFailedException';

/**
 * Recomputes every card's index keys from its fields. It is the migration for any change to how keys are derived; the first
 * such change moved archived cards to a partition of their own.
 */
export async function rekeyCards(deps: Deps): Promise<{ scanned: number; changed: number }> {
  let scanned = 0;
  let changed = 0;
  await scanAll(
    deps,
    {
      FilterExpression: '#type = :card',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':card': 'card' },
    },
    async (card) => {
      scanned += 1;
      const target = keyed(card);
      const set = INDEX_ATTRIBUTES.filter((a) => target[a] !== undefined && target[a] !== card[a]);
      const remove = INDEX_ATTRIBUTES.filter((a) => target[a] === undefined && card[a] !== undefined);
      if (set.length === 0 && remove.length === 0) return;
      const names: Record<string, string> = { '#seq': 'seq', '#updated': 'updatedAt' };
      const values: Record<string, unknown> = { ':seq': card.seq, ':updated': card.updatedAt };
      const clauses: string[] = [];
      for (const a of set) {
        names[`#${a}`] = a;
        values[`:${a}`] = target[a];
        clauses.push(`#${a} = :${a}`);
      }
      for (const a of remove) names[`#${a}`] = a;
      const expr = [
        clauses.length ? `SET ${clauses.join(', ')}` : '',
        remove.length ? `REMOVE ${remove.map((a) => `#${a}`).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      try {
        await deps.db.send(
          new UpdateCommand({
            TableName: deps.config.table,
            Key: { PK: card.PK, SK: card.SK },
            UpdateExpression: expr,
            ConditionExpression: '#seq = :seq AND #updated = :updated',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        changed += 1;
      } catch (error) {
        // The card was written since the scan read it, and that write derived its keys afresh.
        if (!isConditionFailure(error)) throw error;
      }
    },
  );
  return { scanned, changed };
}

/** In order. Append only: a released migration is never edited, so every table walks the same path. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'archived cards move to their own index partitions', run: rekeyCards },
];

export { LATEST_SCHEMA };

export class MigrationLocked extends Error {}

async function readSchema(deps: Deps): Promise<SchemaItem> {
  const out = await deps.db.send(
    new GetCommand({ TableName: deps.config.table, Key: SCHEMA_KEY, ConsistentRead: true }),
  );
  return (out.Item as SchemaItem | undefined) ?? { version: 0 };
}

/** Takes the migration lock, or throws MigrationLocked when another run holds it. */
async function lock(deps: Deps, now: number): Promise<void> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.config.table,
        Key: SCHEMA_KEY,
        UpdateExpression: 'SET #lock = :until, #v = if_not_exists(#v, :zero)',
        ConditionExpression: 'attribute_not_exists(#lock) OR #lock < :now',
        ExpressionAttributeNames: { '#lock': 'lockedUntil', '#v': 'version' },
        ExpressionAttributeValues: { ':until': now + LOCK_MS, ':now': now, ':zero': 0 },
      }),
    );
  } catch (error) {
    if (isConditionFailure(error))
      throw new MigrationLocked('Another migration run holds the lock; try again in 15 minutes.');
    throw error;
  }
}

/**
 * Runs every migration above the table's version, recording each as it finishes, so a run that fails part way resumes at the
 * migration that failed. Returns the version the table is at afterwards.
 */
export async function runMigrations(
  deps: Deps,
  migrations: Migration[] = MIGRATIONS,
): Promise<{ from: number; to: number; applied: string[] }> {
  await lock(deps, deps.now());
  const from = (await readSchema(deps)).version;
  const applied: string[] = [];
  let version = from;
  try {
    for (const m of migrations.filter((x) => x.version > from).toSorted((a, b) => a.version - b.version)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- migrations run in order, each on the result of the last
      const result = await m.run(deps);
      // oxlint-disable-next-line eslint/no-await-in-loop -- the version is recorded before the next migration starts
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.config.table,
          Key: SCHEMA_KEY,
          UpdateExpression: 'SET #v = :v, #h = list_append(if_not_exists(#h, :empty), :entry)',
          ConditionExpression: '#v = :prev',
          ExpressionAttributeNames: { '#v': 'version', '#h': 'history' },
          ExpressionAttributeValues: {
            ':v': m.version,
            ':prev': version,
            ':empty': [],
            ':entry': [{ version: m.version, name: m.name, at: deps.now(), ...result }],
          },
        }),
      );
      version = m.version;
      applied.push(`${m.version} ${m.name}: ${result.changed} of ${result.scanned} changed`);
    }
  } finally {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.config.table,
        Key: SCHEMA_KEY,
        UpdateExpression: 'REMOVE #lock',
        ExpressionAttributeNames: { '#lock': 'lockedUntil' },
      }),
    );
  }
  return { from, to: version, applied };
}
