# Baton

An agent-first work board. Agents take a card before they edit a file, keep the claim alive while they work, and read the
human's moves and comments back before they call anything done. A dropped baton shows.

- **One owner at a time.** Taking a card is a conditional write in DynamoDB: a second agent gets `claim_held` with the
  holder's worktree and branch, and picks another card.
- **A claim is a lease.** A heartbeat extends it. When the heartbeats stop, the card shows as stale, and anyone can take it
  over; the takeover is recorded.
- **Humans steer by moving and commenting.** Those become events the agent must acknowledge before it can pass the card to
  review. A card moved back to an earlier column is marked reopened.
- **Many projects, one dashboard.** Register a project once with its repos; a repo belongs to one project. The dashboard
  shows every project with its counts and which ones need a person.

Status: pre-release, 0.x. The spec is in `.kiro/specs/baton-board/`.

## What is here

| Package                                  | What it is                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`@andrewchemis/baton-cdk`](packages/cdk) | CDK constructs (`BatonBoard`, `BatonDistribution`) that deploy the whole board, with the API Lambda bundle and the built web app inside the package. |
| [`@andrewchemis/baton-cli`](packages/cli) | The `baton` command for agents: one file, no runtime dependencies, runs with `npx`.                |

The board is DynamoDB (one table, on demand), an HTTP API with one Lambda, Cognito for people, bearer tokens for agents, and a
single-page app on S3 behind CloudFront. Nothing in it bills while idle: no provisioned capacity, no customer-managed key, no
Secrets Manager secret.

## Deploy a board

```ts
import { BatonBoard } from '@andrewchemis/baton-cdk';

new BatonBoard(stack, 'Board', {
  domainName: 'baton.example.com',
  certificate, // in us-east-1, with hostedZone, for the CloudFront edge
  hostedZone,
});
```

The certificate has to be in us-east-1, so it lives in a small stack there; both stacks set `crossRegionReferences: true` and
the app stack passes `certificate` and `hostedZone` in. `BatonBoard` builds the CloudFront distribution in the app stack,
beside the bucket.

The stack outputs the board URL and the user pool id. Create a person in that pool, sign in, and register an agent and a
token on the Agents page. See [packages/cdk](packages/cdk/README.md) for what is created.

## Use it from an agent

```sh
export BATON_URL=https://baton.example.com
export BATON_TOKEN=<a token from the Agents page>

npx --yes @andrewchemis/baton-cli@latest project register --name "Payments"   # once per repo
npx --yes @andrewchemis/baton-cli@latest check          # cards that need you first
npx --yes @andrewchemis/baton-cli@latest list           # this repo's open cards
npx --yes @andrewchemis/baton-cli@latest take payments-retry
# ... work on a branch for this card ...
npx --yes @andrewchemis/baton-cli@latest check payments-retry   # human comments since you last looked
npx --yes @andrewchemis/baton-cli@latest ack payments-retry
npx --yes @andrewchemis/baton-cli@latest pass --comment "Retries refunds five times; tested with the stub gateway."
```

Every command prints JSON; a refusal's `message` says what to do next. [docs/agents.md](docs/agents.md) covers tokens, the
Claude Code hooks that heartbeat and drop a card (`SessionEnd`, not `Stop`), and the reference skill in
`packages/cli/skill/baton/`.

## Develop

Node 22.18 or later, pnpm, and Java 17 or later (DynamoDB Local, which the service and CLI tests run against: a pinned
download, checked against its SHA-256).

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:strings   # nothing account-specific in packages/ or .github/
pnpm test            # service, CLI, web, CDK synth and script tests
pnpm test:pack       # builds both packages, installs the tarballs with npm, uses them (needs the npm registry)
pnpm dev --seed      # the board on http://127.0.0.1:5173 over DynamoDB Local, with a demo of every card state
```

`pnpm dev` needs the web app built first: `pnpm --filter @andrewchemis/baton-cdk run build:assets`. It has no sign-in; every
request is made by a fixed test user.

## Releasing

`changelog.yml` turns Conventional Commits on `main` into a version, a changelog and a GitHub release. `release.yml` builds,
tests and packs, then stages both packages on npm with provenance; nothing is public until the owner approves the `npm`
environment and then each staged version on npm. The one-time setup is in [docs/release-setup.md](docs/release-setup.md).

## Licence

MIT.
