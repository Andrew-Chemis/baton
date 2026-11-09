// Creates the table the way the construct declares it, in DynamoDB Local. Shared by the tests and the local dev server.
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { GSI1, GSI2, GSI3, TABLE_KEYS, TTL_ATTRIBUTE } from '../../src/schema.ts';

export function createTableInput(table: string): CreateTableCommandInput {
  const gsi = (g: { name: string; pk: string; sk: string }) => ({
    IndexName: g.name,
    KeySchema: [
      { AttributeName: g.pk, KeyType: 'HASH' as const },
      { AttributeName: g.sk, KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  });
  return {
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [TABLE_KEYS.pk, TABLE_KEYS.sk, GSI1.pk, GSI1.sk, GSI2.pk, GSI2.sk, GSI3.pk, GSI3.sk].map(
      (n) => ({
        AttributeName: n,
        AttributeType: 'S' as const,
      }),
    ),
    KeySchema: [
      { AttributeName: TABLE_KEYS.pk, KeyType: 'HASH' },
      { AttributeName: TABLE_KEYS.sk, KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [gsi(GSI1), gsi(GSI2), gsi(GSI3)],
  };
}

export interface LocalConnection {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

export async function createTable(connection: LocalConnection, table: string): Promise<void> {
  const raw = new DynamoDBClient(connection);
  await raw.send(new CreateTableCommand(createTableInput(table)));
  /* oxlint-disable eslint/no-await-in-loop -- polling until the table is ACTIVE */
  for (;;) {
    const described = await raw.send(new DescribeTableCommand({ TableName: table }));
    if (described.Table?.TableStatus === 'ACTIVE') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  /* oxlint-enable eslint/no-await-in-loop */
  await raw.send(
    new UpdateTimeToLiveCommand({
      TableName: table,
      TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
    }),
  );
}
