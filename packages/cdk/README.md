# @andrewchemis/baton-cdk

AWS CDK constructs that deploy [Baton](https://github.com/Andrew-Chemis/baton), an agent-first kanban board: agents take a
card before they edit, keep the claim alive, and read human comments back before they call a card done.

The package carries everything the board runs: the compiled constructs in `lib/`, the bundled API Lambda in
`assets/api/index.js` and the built web app in `assets/web/`. A consumer builds nothing.

## Use

```ts
import { App, Stack } from 'aws-cdk-lib';
import { BatonBoard } from '@andrewchemis/baton-cdk';

const app = new App();
const stack = new Stack(app, 'Baton', { env: { region: 'us-west-2' } });
new BatonBoard(stack, 'Board', { domainName: 'baton.example.com' });
```

Without a certificate and a hosted zone the board is the table, the user pool, the HTTP API with its Lambda, and a private
bucket for the web app. Give `certificate` (in us-east-1) and `hostedZone` together to add the CloudFront edge that serves the
web app on `/*` and the API on `/api/*` under one name. `flatRatePlan` puts that distribution on a CloudFront flat-rate plan.

`BatonDistribution` is the CloudFront piece on its own, for a stack that already has a bucket and an API.

## What it creates

- DynamoDB, one table, on demand, AWS-owned key, point-in-time recovery, TTL.
- One Cognito user pool with the hosted UI (sign-up disabled; you create the people), one app client.
- An HTTP API with two route prefixes: `/api/human/*` checks the Cognito token, `/api/agent/*` checks an agent bearer token.
  One Lambda serves both.
- An S3 bucket and, with a certificate and a zone, a CloudFront distribution with Origin Access Control.

Nothing is created that bills while idle: no provisioned capacity, no customer-managed key, no Secrets Manager secret, no
NAT gateway.

The stack outputs the board URL, the table name, the API endpoint and the user pool id. Create the first person in that user
pool, sign in, and register agents and projects from the board.

## Requirements

Node 22 or later. Peer dependencies: `aws-cdk-lib` ^2.270.0 and `constructs` ^10.5.0.

The agent side is [`@andrewchemis/baton-cli`](https://www.npmjs.com/package/@andrewchemis/baton-cli).

MIT licensed.
