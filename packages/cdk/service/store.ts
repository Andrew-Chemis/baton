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

export interface Deps {
  db: DynamoDBDocumentClient;
  config: Config;
  now: () => number;
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

export async function getItem<T>(
  deps: Deps,
  key: { PK: string; SK: string },
  consistent = true,
): Promise<T | undefined> {
  const out = await deps.db.send(
    new GetCommand({ TableName: deps.config.table, Key: key, ConsistentRead: consistent }),
  );
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

export async function transact(deps: Deps, items: TransactItem[]): Promise<void> {
  const withTable = items.map((item): TransactItem => {
    if (item.Put) return { Put: { ...item.Put, TableName: deps.config.table } };
    if (item.Update) return { Update: { ...item.Update, TableName: deps.config.table } };
    if (item.Delete) return { Delete: { ...item.Delete, TableName: deps.config.table } };
    if (item.ConditionCheck) return { ConditionCheck: { ...item.ConditionCheck, TableName: deps.config.table } };
    throw new Error('empty transact item');
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

/**
 * An Update that turns `before` into `after`, touching only the top-level attributes that differ, so a concurrent write to
 * an attribute this operation does not change survives. `condition` decides, at the store, whether the update may happen.
 */
export function diffUpdate(
  key: { PK: string; SK: string },
  before: Item,
  after: Item,
  condition?: Condition,
): TransactItem {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Names = {};
  const values: Values = {};
  let n = 0;
  for (const attr of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (attr === 'PK' || attr === 'SK') continue;
    if (isDeepStrictEqual(before[attr], after[attr])) continue;
    const name = `#d${n}`;
    names[name] = attr;
    if (after[attr] === undefined) {
      removes.push(name);
    } else {
      const value = `:d${n}`;
      values[value] = after[attr];
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
  if (!clauses) {
    // Nothing differs: still guard the item, so the operation's condition is checked.
    return {
      ConditionCheck: {
        TableName: '',
        Key: key,
        ConditionExpression: condition?.expr ?? 'attribute_exists(PK)',
        ...(condition?.names && Object.keys(condition.names).length > 0
          ? { ExpressionAttributeNames: condition.names }
          : {}),
        ...(condition?.values && Object.keys(condition.values).length > 0
          ? { ExpressionAttributeValues: condition.values }
          : {}),
      },
    };
  }
  const allNames = { ...names, ...condition?.names };
  const allValues = { ...values, ...condition?.values };
  return {
    Update: {
      TableName: '',
      Key: key,
      UpdateExpression: clauses,
      ConditionExpression: condition?.expr ?? 'attribute_exists(PK)',
      ExpressionAttributeNames: allNames,
      ...(Object.keys(allValues).length > 0 ? { ExpressionAttributeValues: allValues } : {}),
    },
  };
}

export function putItem(item: Item, condition?: Condition): TransactItem {
  return {
    Put: {
      TableName: '',
      Item: item,
      ...(condition ? { ConditionExpression: condition.expr } : {}),
      ...(condition?.names && Object.keys(condition.names).length > 0
        ? { ExpressionAttributeNames: condition.names }
        : {}),
      ...(condition?.values && Object.keys(condition.values).length > 0
        ? { ExpressionAttributeValues: condition.values }
        : {}),
    },
  };
}

export function deleteItem(key: { PK: string; SK: string }, condition?: Condition): TransactItem {
  return {
    Delete: {
      TableName: '',
      Key: key,
      ...(condition ? { ConditionExpression: condition.expr } : {}),
      ...(condition?.names && Object.keys(condition.names).length > 0
        ? { ExpressionAttributeNames: condition.names }
        : {}),
      ...(condition?.values && Object.keys(condition.values).length > 0
        ? { ExpressionAttributeValues: condition.values }
        : {}),
    },
  };
}
