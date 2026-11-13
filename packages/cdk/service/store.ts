import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config.ts';
import type { Telemetry } from './telemetry.ts';

export interface Deps {
  db: DynamoDBDocumentClient;
  config: Config;
  now: () => number;
  /** Where request lines and metrics go. Absent in tests that do not look at them: nothing is written. */
  telemetry?: Telemetry;
}

export function createDocClient(
  options: { endpoint?: string; region?: string; credentials?: { accessKeyId: string; secretAccessKey: string } } = {},
): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export type Item = Record<string, unknown>;
export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export type Names = Record<string, string>;
export type Values = Record<string, unknown>;

export interface Condition {
  expr: string;
  names?: Names;
  values?: Values;
}

export interface Key {
  PK: string;
  SK: string;
}

export const EXISTS: Condition = { expr: 'attribute_exists(PK)' };
export const NOT_EXISTS: Condition = { expr: 'attribute_not_exists(PK)' };

/** A strongly consistent read: every caller decides something from what it gets back. */
export async function getItem<T>(deps: Deps, key: Key): Promise<T | undefined> {
  const out = await deps.db.send(new GetCommand({ TableName: deps.config.table, Key: key, ConsistentRead: true }));
  return out.Item as T | undefined;
}

export async function queryAll<T>(deps: Deps, input: Omit<QueryCommandInput, 'TableName'>): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the previous page's key
    const out = await deps.db.send(
      new QueryCommand({
        ...input,
        TableName: deps.config.table,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...((out.Items ?? []) as T[]));
    startKey = out.LastEvaluatedKey;
  } while (startKey && (input.Limit === undefined || items.length < input.Limit));
  return input.Limit === undefined ? items : items.slice(0, input.Limit);
}

/** Thrown when a transaction is cancelled. `reasons[i]` is the DynamoDB cancellation code of item i, undefined when it was fine. */
export class Cancelled extends Error {
  readonly reasons: (string | undefined)[];
  constructor(reasons: (string | undefined)[]) {
    super(`transaction cancelled: ${reasons.map((r, i) => `${i}:${r ?? 'ok'}`).join(' ')}`);
    this.reasons = reasons;
  }
  failed(index: number): boolean {
    return this.reasons[index] === 'ConditionalCheckFailed';
  }
  /** Another transaction touched the same item at the same moment; safe to retry. */
  get conflict(): boolean {
    return this.reasons.some((r) => r === 'TransactionConflict');
  }
}

const KINDS = ['Put', 'Update', 'Delete', 'ConditionCheck'] as const;

export async function transact(deps: Deps, items: TransactItem[]): Promise<void> {
  const withTable = items.map((item): TransactItem => {
    const kind = KINDS.find((k) => item[k]);
    if (!kind) throw new Error('empty transact item');
    return { [kind]: { ...item[kind], TableName: deps.config.table } };
  });
  try {
    await deps.db.send(new TransactWriteCommand({ TransactItems: withTable }));
  } catch (error) {
    const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
    if ((error as { name?: string }).name === 'TransactionCanceledException' && reasons) {
      throw new Cancelled(reasons.map((r) => (r.Code === 'None' ? undefined : r.Code)));
    }
    throw error;
  }
}

export function merge(...conditions: (Condition | undefined)[]): Condition | undefined {
  const present = conditions.filter((c): c is Condition => c !== undefined);
  if (present.length === 0) return undefined;
  return {
    expr: present.map((c) => `(${c.expr})`).join(' AND '),
    names: Object.assign({}, ...present.map((c) => c.names ?? {})) as Names,
    values: Object.assign({}, ...present.map((c) => c.values ?? {})) as Values,
  };
}

const attributeFields = (c?: Condition) => ({
  ...(c?.names && Object.keys(c.names).length > 0 ? { ExpressionAttributeNames: c.names } : {}),
  ...(c?.values && Object.keys(c.values).length > 0 ? { ExpressionAttributeValues: c.values } : {}),
});

const conditionFields = (c?: Condition) => ({ ...(c ? { ConditionExpression: c.expr } : {}), ...attributeFields(c) });

/** Guards an item inside a transaction without changing it. */
export function conditionCheck(key: Key, condition: Condition = EXISTS): TransactItem {
  return {
    ConditionCheck: { TableName: '', Key: key, ConditionExpression: condition.expr, ...attributeFields(condition) },
  };
}

/** An UpdateExpression with its own names and values (`update`), guarded by `condition` (the item must exist, by default). */
export function updateItem(key: Key, update: Condition, condition: Condition = EXISTS): TransactItem {
  const both = { names: { ...update.names, ...condition.names }, values: { ...update.values, ...condition.values } };
  return {
    Update: {
      TableName: '',
      Key: key,
      UpdateExpression: update.expr,
      ConditionExpression: condition.expr,
      ...attributeFields({ expr: condition.expr, ...both }),
    },
  };
}

/**
 * An Update that turns `before` into `after`, touching only the top-level attributes that differ, so a concurrent write to
 * an attribute this operation does not change survives. `condition` decides, at the store, whether the update may happen.
 */
export function diffUpdate<T extends object>(key: Key, before: T, after: T, condition?: Condition): TransactItem {
  const was = before as Item;
  const now = after as Item;
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Names = {};
  const values: Values = {};
  let n = 0;
  for (const attr of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (attr === 'PK' || attr === 'SK') continue;
    if (isDeepStrictEqual(was[attr], now[attr])) continue;
    const name = `#d${n}`;
    names[name] = attr;
    if (now[attr] === undefined) {
      removes.push(name);
    } else {
      const value = `:d${n}`;
      values[value] = now[attr];
      sets.push(`${name} = ${value}`);
    }
    n += 1;
  }
  const clauses = [
    sets.length > 0 ? `SET ${sets.join(', ')}` : '',
    removes.length > 0 ? `REMOVE ${removes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Nothing differs: still guard the item, so the operation's condition is checked.
  if (!clauses) return conditionCheck(key, condition);
  return updateItem(key, { expr: clauses, names, values }, condition);
}

export function putItem(item: object, condition?: Condition): TransactItem {
  return { Put: { TableName: '', Item: item as Item, ...conditionFields(condition) } };
}

/** A Put that fails if the item already exists. */
export const putNew = (item: object): TransactItem => putItem(item, NOT_EXISTS);

export function deleteItem(key: Key, condition?: Condition): TransactItem {
  return { Delete: { TableName: '', Key: key, ...conditionFields(condition) } };
}
