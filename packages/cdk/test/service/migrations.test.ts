// Migrations against DynamoDB Local: they bring old-shaped items forward, record the version, resume after a failure, and
// never run twice at once.
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, test } from 'vitest';
import { cardKey } from '../../service/keys.ts';
import {
  LATEST_SCHEMA,
  MIGRATIONS,
  MigrationLocked,
  SCHEMA_KEY,
  runMigrations,
  type Migration,
} from '../../service/migrations.ts';
import type { Deps } from '../../service/store.ts';
import { REPO, newCard, seeded } from '../support/board.ts';

const read = async (deps: Deps, key: { PK: string; SK: string }): Promise<Record<string, any> | undefined> =>
  (await deps.db.send(new GetCommand({ TableName: deps.config.table, Key: key, ConsistentRead: true }))).Item;

/** Puts an archived card's index keys back where code before the archived shelf left them. */
const ageCard = (deps: Deps, id: string, projectId: string) =>
  deps.db.send(
    new UpdateCommand({
      TableName: deps.config.table,
      Key: cardKey(id),
      UpdateExpression: 'SET GSI1PK = :b, GSI2PK = :r',
      ExpressionAttributeValues: { ':b': `BOARD#${projectId}`, ':r': `REPO#${REPO}` },
    }),
  );

describe('the list', () => {
  test('versions run 1, 2, 3 ... without a gap and end at the version the construct deploys', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: LATEST_SCHEMA }, (_, i) => i + 1));
  });
});

describe('runMigrations', () => {
  test('moves old-shaped cards forward, records the version and its history, and a second run does nothing', async () => {
    const s = await seeded();
    const live = await newCard(s.human);
    const gone = await newCard(s.human);
    await s.human.post(`/cards/${gone.id}/archive`);
    await ageCard(s.board.deps, gone.id, s.projectId);
    expect((await read(s.board.deps, cardKey(gone.id)))?.GSI1PK).toBe(`BOARD#${s.projectId}`);

    const first = await runMigrations(s.board.deps);
    expect(first).toMatchObject({ from: 0, to: LATEST_SCHEMA });
    expect(first.applied[0]).toContain('1 of 2 changed');
    expect((await read(s.board.deps, cardKey(gone.id)))?.GSI1PK).toBe(`BOARD#${s.projectId}#ARCHIVED`);
    expect((await s.human.get(`/cards?project=${s.projectId}`)).body.cards.map((c: any) => c.id)).toEqual([live.id]);

    const schema = await read(s.board.deps, SCHEMA_KEY);
    expect(schema).toMatchObject({
      version: LATEST_SCHEMA,
      history: [expect.objectContaining({ version: 1, changed: 1 })],
    });
    expect(schema?.lockedUntil).toBeUndefined();

    expect(await runMigrations(s.board.deps)).toEqual({ from: LATEST_SCHEMA, to: LATEST_SCHEMA, applied: [] });
  });

  test('a failed migration leaves the version at the last one that finished, and the next run resumes there', async () => {
    const s = await seeded();
    const ran: number[] = [];
    let fail = true;
    const steps: Migration[] = [1, 2, 3].map((version) => ({
      version,
      name: `step ${version}`,
      run: () => {
        if (version === 2 && fail) return Promise.reject(new Error('boom'));
        ran.push(version);
        return Promise.resolve({ scanned: 0, changed: 0 });
      },
    }));
    await expect(runMigrations(s.board.deps, steps)).rejects.toThrow('boom');
    expect((await read(s.board.deps, SCHEMA_KEY))?.version).toBe(1);
    fail = false;
    expect(await runMigrations(s.board.deps, steps)).toMatchObject({ from: 1, to: 3 });
    expect(ran).toEqual([1, 2, 3]);
  });

  test('a second run while one holds the lock is refused, and a lock older than its lease is taken over', async () => {
    const s = await seeded();
    let release: () => void = () => {};
    const slow: Migration[] = [
      {
        version: 1,
        name: 'slow',
        run: () => new Promise((done) => (release = () => done({ scanned: 0, changed: 0 }))),
      },
    ];
    const running = runMigrations(s.board.deps, slow);
    await expect.poll(async () => (await read(s.board.deps, SCHEMA_KEY))?.lockedUntil).toBeDefined();
    await expect(runMigrations(s.board.deps, slow)).rejects.toBeInstanceOf(MigrationLocked);
    release();
    await running;

    await s.board.deps.db.send(
      new UpdateCommand({
        TableName: s.board.deps.config.table,
        Key: SCHEMA_KEY,
        UpdateExpression: 'SET lockedUntil = :past',
        ExpressionAttributeValues: { ':past': s.board.clock.now() - 1 },
      }),
    );
    expect((await runMigrations(s.board.deps, slow)).to).toBe(1);
  });
});
