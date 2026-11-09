// Makes a real DynamoDB available to the service and CLI tests. DYNAMODB_ENDPOINT wins (CI starts DynamoDB Local before the
// tests and sets it); without it a pinned DynamoDB Local is started on a free port. There is no in-memory stand-in: with no
// endpoint and no Java the suite fails here, loudly, rather than passing against something that is not DynamoDB.
import { startDynamoDbLocal, type RunningDynamoDb } from '../../../../scripts/dynamodb-local.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
    dynamodbBackend: string;
  }
}

interface Shared {
  running?: Promise<RunningDynamoDb>;
  users: number;
}
const shared: Shared = ((globalThis as { batonDdb?: Shared }).batonDdb ??= { users: 0 });

export default async function setup(project: {
  provide: (key: 'dynamodbEndpoint' | 'dynamodbBackend', value: string) => void;
}) {
  const configured = process.env.DYNAMODB_ENDPOINT;
  shared.users += 1;
  if (configured) {
    project.provide('dynamodbEndpoint', configured);
    project.provide('dynamodbBackend', `DynamoDB Local at DYNAMODB_ENDPOINT=${configured}`);
  } else {
    shared.running ??= startDynamoDbLocal();
    const running = await shared.running;
    project.provide('dynamodbEndpoint', running.endpoint);
    project.provide('dynamodbBackend', `DynamoDB Local 3.3.2 started by the test run at ${running.endpoint}`);
  }
  return async () => {
    shared.users -= 1;
    if (shared.users === 0 && shared.running) {
      (await shared.running).stop();
      delete shared.running;
    }
  };
}
