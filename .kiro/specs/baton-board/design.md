# Design — Baton

Requirements: `requirements.md`. Goals: `intent.md`. Where the build differs
from the text below, "Deviations" says so and the requirements still hold.
"Verified" records what was checked and how; "Not verified" lists what could
not be checked from a build sandbox and what covers for it.

## Shape

```
human browser ─► CloudFront ─┬─ /*      → S3 (SPA, OAC)
                             └─ /api/*  → API Gateway HTTP API
agent CLI ─────────────────────► /api/*     ├─ JWT authorizer (Cognito)   human routes
                                            ├─ Lambda authorizer (token)  agent routes
                                            └─ one Lambda (Node, esbuild) ─► DynamoDB (one table)
```

One Lambda serves every route; route groups are modules, not functions, so
adding a route adds no asset job. Two authorizers because the two callers hold
different credentials (Req 6.5, 7.1). No queue, no scheduler, no stream:
staleness is computed on read (Req 2.3), and every state change is a
conditional write.

Three deliverables, one spec. In the public `baton` repo: a pnpm workspace
with `packages/cdk` (the construct, the API Lambda source and the web app),
`packages/cli` (the agent CLI) and the release workflows. In `claude-plugins`:
the `baton` skill (`SKILL.md` and two hooks) that calls the CLI. In
`andrewchemis.dev`: a thin `apps/baton` that instantiates the construct with
the account's domain, certificate and zone and deploys it through the
existing pipeline. The public repo deploys nothing itself.

## Table

One table, `PK`/`SK`, pay per request, AWS-owned key, point-in-time recovery
on. Two GSIs.

| Item        | PK              | SK                  | GSI1 (board view)              | GSI2 (repo view)        |
| ----------- | --------------- | ------------------- | ------------------------------ | ----------------------- |
| Project     | `PROJECT#<id>`  | `META`              | `PROJECTS` / `<name>`          |                         |
| Repo map    | `REPO#<repo>`   | `META`              |                                |                         |
| Card        | `CARD#<id>`     | `META`              | `BOARD#<project>` / `COL#<col>#<pos>` | `REPO#<repo>` / `CARD#<id>` |
| Event       | `CARD#<id>`     | `EVT#<seq, 8 digits>` |                              |                         |
| Key         | `KEY#<repo>/<slug>` | `META`          |                                |                         |
| Agent       | `AGENT#<id>`    | `META`              |                                |                         |
| Token       | `TOKEN#<sha256>`| `META`              |                                |                         |
| Idempotency | `IDEM#<actor>#<key>` | `META`         |                                |                         |

Project attributes: `id`, `name`, `repos[]`, `archived`, `lastEventAt`,
`createdAt`. The Repo map item holds `projectId`, so the CLI resolves a
project from the origin URL in one read and a repo cannot sit in two
projects (Req 10.2): registering a repo is a conditional put on that item in
the same transaction as the project update. Per-project counts for the
dashboard (Req 10.4) come from a query of `GSI1` for `BOARD#<project>` and a
fold over `state`; at this scale that is cheaper than maintained counters
and never drifts. `lastEventAt` is written on the project by every card
transaction.

Card attributes: `id`, `projectId`, `key?`, `title`, `body`, `repo`, `column`, `pos`
(LexoRank-style string that sorts lexicographically, for drag ordering),
`seq` (last event number), `lastHumanSeq` (last event by a human),
`lastAgentId`, `ackedSeq`, `reopened`, `archived`, `links[]`, `claim?`,
`createdAt`, `updatedAt`.

`claim`: `{ agentId, repo, worktree, branch, session, leaseUntil,
heartbeatAt }`. The claim lives on the card item so one conditional
`UpdateItem` both tests and sets it (Req 1.2). `lastAgentId` and `ackedSeq`
sit on the card, not inside `claim`, so they survive a `pass`: the agent that
passed a card to review is still the one a reopen or a comment must reach
(Req 3.5), and the unread badge (Req 3.4) does not vanish with the claim.
Events live as separate items written in the same `TransactWriteItems` as the
card update, so `seq` and the event list cannot disagree.

Idempotency items carry a DynamoDB TTL of 24 hours and store the first
response body (Req 7.2). Nothing else expires.

## Conditional writes

| Operation | Condition |
| --- | --- |
| claim | `attribute_not_exists(claim) OR claim.leaseUntil < :now OR claim.agentId = :me` |
| heartbeat | `claim.agentId = :me` |
| release | `claim.agentId = :me` |
| ack | `lastAgentId = :me AND seq >= :n` |
| agent move to in_review or done | `claim.agentId = :me AND ackedSeq >= lastHumanSeq` |
| create with key | `attribute_not_exists(PK)` on the Key item, in the same transaction as the Card |
| register repo | `attribute_not_exists(PK)` on the Repo map item, in the same transaction as the Project |
| archive project | no card in the project with `attribute_exists(claim)`, checked by query before a conditional update on `lastEventAt` |

A failed condition returns the current card, so the caller gets the
conflicting claim or sequence in one round trip (Req 7.4). An expired-lease
claim that succeeds reads the old `claim.agentId` from `ReturnValues:
ALL_OLD` to write the `taken_over` event. The move condition compares against
`lastHumanSeq`, not `seq`: the agent's own events (its claim, its comments)
raise `seq` and must not block its own move.

Lease length is 10 minutes; the heartbeat hook fires at most once a minute.
A card whose agent has been silent for 10 minutes shows stale (Req 2.3). Both
are stage config, not code.

## Events, not versions

Human edits are delivered as an event log the agent acknowledges (Req 3), not
as a version number it compares. A version says a card changed; an agent
needs to know what changed and must receive a comment's text, and an ack
pointer lets the board show "agent has not seen this" (Req 3.4). The log also
answers "who moved this and when" for free.

Event: `{ seq, at, actor: { kind: human|agent, id }, type, payload }`. Types:
`created`, `edited`, `moved { from, to }`, `commented { text }`, `claimed`,
`taken_over { previous }`, `released { reason, to? }`. Heartbeats write no
event (Req 2.1).

Columns are ordered in board config: `backlog < ready < in_progress <
in_review < done`, plus `blocked`, which is outside the order and never
triggers reopen. A human move to a lower-ranked column sets `reopened`
(Req 4.1); the next successful claim clears it (Req 4.2). A human move to
`done` clears the claim with reason `human_done` (Req 4.3).

## API

All routes under `/api`. Agent routes take `Authorization: Bearer <token>` and
`Idempotency-Key` on writes; human routes take the Cognito ID token.

| Method, path | Who | Does |
| --- | --- | --- |
| `GET /projects` | both | dashboard: every project with counts by state, `lastEventAt` (Req 10.4) |
| `POST /projects`, `PATCH /projects/{id}`, `POST /projects/{id}/archive` | both | register (name, repos), rename, add or remove repos, archive (Req 10.1, 10.5) |
| `GET /cards?project=&repo=&column=&archived=` | both | board or repo listing, staleness computed |
| `GET /cards?attention=me` | agent | cards whose `lastAgentId` is the caller and that are `reopened` or have `lastHumanSeq > ackedSeq` (Req 3.5) |
| `POST /cards` | both | create; project resolved from `repo` (Req 10.3); `key` dedupes (Req 5.4) |
| `GET /cards/{id}` | both | card with claim and staleness |
| `PATCH /cards/{id}` | both | title, body, links; `edited` event |
| `POST /cards/{id}/move` | both | `{ to, pos }`; reopen and done rules |
| `POST /cards/{id}/comments` | both | `commented` event |
| `GET /cards/{id}/events?since=` | both | events after `since`, at most 200 (Req 3.2); `more` is true when there are further events, and `seq` is then the last event returned, so the next call passes it as `since` (`check` loops on it); once `more` is false `seq` is the card's sequence |
| `POST /cards/{id}/claim` | agent | conditional claim (Req 1) |
| `POST /cards/{id}/heartbeat` | agent | extend lease (Req 2.1) |
| `POST /cards/{id}/ack` | agent | `{ seq }` (Req 3.3) |
| `POST /cards/{id}/release` | agent | `{ reason, to? }` (Req 2.4) |
| `POST /cards/{id}/archive` | human | hide from board |
| `GET/POST/DELETE /agents`, `/agents/{id}/tokens` | human | agent identities and tokens (Req 7.1) |

Errors: `{ code, message, card? }` with codes `claim_held`, `not_holder`,
`seq_ahead`, `unacked_comments`, `missing_worktree`, `token_revoked`,
`idempotent_replay`, `repo_unregistered`, `repo_taken`, `project_has_claims`.
A listing marks each card `state: claimed | stale |
unowned | unclaimed` from `claim`, `leaseUntil` and `column`, and `unread:
true` when `lastHumanSeq > ackedSeq`.

## Auth

Humans: one Cognito user pool, hosted UI, the HTTP API's JWT authorizer.
Agents: a bearer token per agent identity, created from the board, shown
once, stored as its SHA-256; a Lambda authorizer looks the hash up and caches
the result for five minutes, which is the revocation window Req 7.1 allows.
Revoking deletes the Token item. Cognito's
client-credentials flow was the alternative and is not used: machine-to-machine
app clients are billed per token request, and a token the agent reads from
one environment variable is the cheaper, simpler fit for the cost policy.

The CLI reads `BATON_URL` and `BATON_TOKEN`, then falls back to
`/baton/agent-token` in SSM when the environment has AWS credentials
(Req 8.3). A remote Claude session gets the token as an environment secret.

## Web app

Vite SPA on S3 behind CloudFront with OAC, flat-rate plan as the other apps,
SPA rewrite by CloudFront Function, `/api/*` to the HTTP API. The headers
function that already adds the security headers also marks a served
`/assets/*` file `immutable` for a year (Vite names those by content hash);
the bucket's `max-age=0, must-revalidate` stays on everything else. No second
deployment, no cache or response-headers policy, so the FREE and PRO tiers
still apply. Three pages.
The dashboard (`/`) lists every project as a row: name, repos, the five
counts, last activity, and a link to its board; a register form takes a name
and repos. The board (`/p/<project>`) has columns, drag with pointer events,
a card drawer for body, events and a comment box, a repo filter and project
settings (rename, repos, archive). The agents page holds tokens. The
dashboard polls `GET /projects` and the board `GET /cards?project=` every 15
seconds; no WebSocket. Card badges: owner and branch, stale (lease
expired), unowned (in-progress column, no claim), reopened, unread (owner's
`ackedSeq < seq` of the latest human event).

## Skill

`plugins/skills/skills/baton/` in `claude-plugins`: `SKILL.md`,
`hooks/heartbeat.sh`, `hooks/stop.sh`. The CLI itself is the published
`@andrewchemis/baton-cli`; the hooks and the skill call it through `npx` at a
pinned version, so the plugin ships no copy of it. The CLI resolves repo from
the origin
URL, worktree from `git rev-parse --show-toplevel`, branch from `git
rev-parse --abbrev-ref HEAD`, and session from `CLAUDE_CODE_SESSION_ID` or `CLAUDE_SESSION_ID` when set.
Every command resolves the project through the Repo map and fails with
`repo_unregistered` when the repo belongs to none; `baton project register
--name <name>` creates the project or adds the repo to an existing one of
that name (Req 10.1). `take` writes `.git/baton-card` (worktree-local) so the hooks know which
card to heartbeat and drop without arguments. The verbs follow the metaphor:
`take` is the claim route, `pass` is release plus move (reason `done`, `--to`
defaults to `in_review`), `drop` is release in place (`--reason paused` or
`blocked`); the API keeps the nouns `claim` and `release`. `SKILL.md`
prescribes the loop: `check` with no card id first (the attention list, Req
3.5), then `list` for the repo, `take` or stop, work, `check <id>` plus `ack`
before any `pass`, `drop` when stopping early, or let the stop hook drop with
`session_ended`.

## Packages

`@andrewchemis/baton-cdk` exports `BatonBoard`, a construct that owns the
table, user pool, HTTP API, Lambda and SPA bucket and, when given a
certificate and a zone, the CloudFront edge, built by `BatonDistribution`.
`BatonDistribution` is exported for a stack that already has a bucket and an
API, and it must share a stack with that bucket (Deviation 13). Props: `domainName`, `certificate`,
`hostedZone`, `leaseMinutes`, `heartbeatSeconds`, `protectData`,
`flatRatePlan?`. The tarball carries `lib/` (compiled construct),
`assets/api/index.js` (esbuild bundle of the Lambda, one file) and
`assets/web/` (the Vite build); the construct uses `Code.fromAsset` and
`BucketDeployment` from those paths, resolved relative to the package, so a
consumer runs no build of this code. `aws-cdk-lib` and `constructs` are peers.

`@andrewchemis/baton-cli` is one dependency-free Node script with a `bin`,
so `npx @andrewchemis/baton-cli take <id>` works in a remote session
without `pnpm install`. Both packages share one version pinned in lockstep
(`workspace:*` packs as exact).

Nothing account-specific enters the published packages: a CI check greps
`packages/` outside `test/` and `.github/` for 12-digit numbers, `arn:aws:`
and the owner's domain, and fails on a hit (Req 9.3). The spec and README are
outside the check so they can name the consuming repo.

## Publishing

Lede's model, two workflows, SHA-pinned, `permissions: {}` at the top.

`changelog.yml` on push to `main`: computes the next version from
Conventional Commits (every type a patch, a minor only by a `chore(minor):`
commit from the owner, never a major on 0.x), writes `CHANGELOG.md` and the
version into both packages, commits with the skip-CI marker, tags, and
publishes a GitHub release.

`release.yml` on `release: published`, two jobs. `build`: checks the tag is
on `main` and matches the package version, installs, typechecks, lints,
tests, runs a pack test that installs both tarballs in a temp dir and runs
the bin and a synth against the construct, then uploads the tarballs and
writes their file lists and hashes to the run summary. `publish`: no
checkout, no install of repository code, `environment: npm`, `id-token:
write` only; stages both tarballs with `npm stage publish` and provenance via
trusted publishing. The owner approves the environment on the run, then
approves each staged version on npm with 2FA. The first publish bootstraps
with an `NPM_TOKEN` on the environment; the token is deleted once trusted
publishing names this repo and workflow.

`ci.yml` on pull requests: typecheck, lint, format check, the
account-specific-string check, tests, pack test.

## Consumer

`andrewchemis.dev/apps/baton`: a `CdkPipelinesTemplateProject` on
tributary's layout with `@andrewchemis/baton-cdk` in `deps`. Its
`CertificateStack` (us-east-1) holds the delegated zone, certificate and web
ACL; its app stack (us-west-2, `crossRegionReferences: true`) holds
`BatonBoard`, to which it passes `certificate`, `hostedZone` and, for the
flat-rate plan, `flatRatePlan` with the web ACL's ARN. `BatonBoard` builds the
distribution in the app stack, next to the bucket. Config in its `app-config.ts`, deploy through `HardenedGitHubWorkflow` and
the landing-zone role, table and pool retained with deletion protection. A
synth test asserts the two asset paths exist in the installed package, so a
broken tarball fails the consumer's CI rather than its deploy (Req 9.6).
Upgrading is a version bump in `.projenrc.ts` and `pnpm install`.

## Verified

Each item says how it was checked. "Ran" means a test in this repository ran
it; "docs" means a documentation page read while building, not a deployment.

### The four open design points

1. **Both kinds of route, one authorizer per route.** An HTTP API takes an
   authorizer per route (the CDK authorizers documentation: route
   authorization "takes precedence over default authorization"; its examples
   put a JWT authorizer on one route and a Lambda authorizer on another).
   The construct therefore splits the path space: `/api/human/*` sits behind
   the Cognito JWT authorizer, `/api/agent/*` behind a Lambda authorizer
   that reads the bearer token. A route both callers use (`/projects`,
   `/cards`, comments, moves) is registered under both prefixes, and the
   router checks that the caller kind and the route agree. CloudFront
   forwards `/api/*` unchanged. Checked: the synth test counts exactly two
   authorizers and fails if any route lacks one. Not checked: a deployed API
   (see "Not verified").
2. **Testing against real conditional writes.** The service and CLI tests run
   against DynamoDB Local 3.3.2, a pinned download whose SHA-256 is checked
   before it is unpacked, started by the vitest global setup (or a given
   `DYNAMODB_ENDPOINT`). Every claim, heartbeat, release, ack, move,
   registration and idempotency test makes real `ConditionExpression` and
   `TransactWriteItems` calls; nothing in the service is faked. The table the
   tests create comes from the same key and index definitions the construct
   uses. Ran: the `service` and `cli` projects. Not DynamoDB itself: DynamoDB
   Local does not enforce throughput, and it does not delete expired TTL items
   on AWS's schedule, so the 24-hour idempotency window is tested with an
   injected clock (a key is free again after 24 hours even though the item is
   still in the table), and the `ttl` attribute is written but its deletion is
   not observed.
3. **Toolchain.** Node 22 or later for the packages (`engines`), 22.18 or
   later for the repository (native TypeScript execution and
   `import.meta.main`). The API Lambda runs on `nodejs24.x`
   (`Runtime.NODEJS_24_X`, in `aws-cdk-lib` before 2.270.0) and its bundle is
   built for `node24`. No projen: the workspace is plain pnpm 10.28.0
   with TypeScript 7.0.2, oxlint, oxfmt, vitest 5. `aws-cdk-lib` ^2.270.0 and
   `constructs` ^10.5.0 are peers; 2.270.0 is the first release with
   `aws-cdk-lib/aws-pricingplanmanager`, which the flat-rate plan needs. Ran:
   the pack test installs both tarballs with npm next to exactly
   `aws-cdk-lib@2.270.0` and `constructs@10.5.0`, synthesizes a board and
   type-checks a consumer; the workspace itself builds and synth-tests on
   2.275.x, so both ends of the range are covered.
4. **Asset paths inside `node_modules`.** `lib/` is compiled to CommonJS
   (`tsconfig.build.json` turns `verbatimModuleSyntax` off for this build
   only), and `lib/assets.js` resolves `assets/api` and `assets/web` as
   `__dirname/..`, so they are found inside the installed package wherever
   it sits. Ran: the pack test confirms the paths the installed package
   reports are inside its own directory and that `app.synth()` stages one
   asset directory holding `index.js` and one holding `index.html`. Not run:
   the same under pnpm's global virtual store as `andrewchemis.dev` uses.
   Node resolves a module's `__dirname` to its real path there, and the
   assets are copied into `cdk.out` when staged, so no failure is expected;
   task 12's asset-path synth test in the consumer is what proves it.

### Other facts

- **Agent auth without Cognito client credentials.** A bearer token is a
  random value shown once, stored as its SHA-256, checked by a Lambda
  authorizer whose result API Gateway caches for five minutes (`resultsCacheTtl`
  in the construct). An HTTP API cannot customize a denial, so the authorizer
  always authorizes a request that carries an `Authorization` header, records a
  verdict (`ok`, `revoked`, `unknown`) in its context, and the handler turns
  any other verdict into the coded error the agent can act on. Ran: the
  router tests for each verdict and the idempotency of refusals. The
  claim that a deny is a bare 403 comes from the API Gateway documentation as
  read; it was not exercised on a deployed API. Cognito's machine-to-machine
  pricing was not looked up: the decision does not rest on it, because the
  bearer-token path has no standing charge and no per-token-request charge by
  construction.
- **Claude Code hooks** (the hooks documentation, read for task 8):
  - `Stop` fires at the end of every turn; `SessionEnd` fires when a session
    terminates. A stop hook that drops the card must be `SessionEnd`.
  - A `SessionEnd` hook has a 1.5 second budget unless its hook entry sets a
    longer `timeout` (seconds; at most 60). The reference config sets 20.
  - `PostToolUse` hooks run after each tool call; the hook input carries
    `session_id` on stdin.
  - Neither `CLAUDE_CODE_SESSION_ID` (set in cloud sessions) nor `CLAUDE_SESSION_ID`
    is documented as an environment variable, so the CLI uses the first one set and otherwise makes a label (`local-<hex>`) that
    it keeps in the worktree's state file. The holder identity is
    `agentId#worktree` either way, never the session label.
  - A cloud session does not read the user-level `~/.claude/settings.json`; it
    reads the repository's `.claude/settings.json`, and hooks configured there
    do run. Ran: the hook scripts against a fake `npx` (`test/skill.test.ts`).
- **State file location.** `git rev-parse --git-path baton-card` is
  worktree-local (`.git/worktrees/<name>/` in a linked worktree, `.git/` in
  the main one), so two worktrees of one repository never share a card.
  Ran: `checkout.test.ts` with two real linked worktrees.
- **SigV4 without the SDK.** The CLI signs its own SSM `GetParameter`
  request. Ran: it reproduces the AWS documentation's published signature for
  the IAM `ListUsers` example, and agrees byte for byte with
  `@smithy/signature-v4` on three requests (a JSON POST, one with a session
  token, one whose query needs sorting and encoding). Credentials from a
  provider chain (SSO, an assumed role, a container role) cannot be read without
  the SDK; for those the CLI runs `aws ssm get-parameter` when the `aws`
  command is installed and a signal of AWS configuration is present, and says
  what to set when neither works. Ran against a stub `aws` and a stub SSM
  endpoint, not against SSM.
- **Publishing.** npm trusted publishing needs npm 11.5.1 or later and Node
  22.14 or later; the workflow file name (with extension) and, optionally, the
  environment name are entered in the package's settings on npmjs.com, the
  package's `repository.url` must match the repository exactly, and provenance
  is generated for a public repository (npm documentation). A new
  trusted-publisher configuration must complete its first publish within two
  days. `npm stage publish` shipped in npm 11.15.0 (a third-party write-up of
  the release; the sibling pipeline's pinned npm 11.21.1 exists on the
  registry, checked with `npm view`). Ran: the workflows are parsed and held to
  the rules in Req 9.4-9.5 by `test/workflows.test.ts`; the release rules are
  run through the real commit analyzer.
- **CI runner.** The ubuntu-24.04 runner image lists Java 17.0.20 as its
  default (the runner-images readme), which DynamoDB Local 3.x needs; the job
  prints `java -version` so a change shows in the log.

## Not verified

Each of these needs something a build sandbox cannot do. The mitigation says
what stands in for it.

- **Cognito hosted UI called from the browser.** The sign-in is the
  authorization-code flow with PKCE against the hosted UI, and the token
  exchange is a cross-origin `POST` to `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/token`
  from the page. Ran: the web tests against a stubbed `fetch` (code
  exchange, refresh, expiry, sign-out, a failed exchange); the CSP allows
  `connect-src https://*.amazoncognito.com`. Not run: a real pool. If the
  hosted UI's CORS behaviour differs, the symptom is a sign-in that returns
  to the board and shows the failed-exchange message; the fix would be a
  same-origin proxy route, which is a change to the construct only.
- **A deployed board.** Nothing here was deployed: the HTTP API's two
  authorizers, the CloudFront behaviours and flat-rate plan, the Cognito
  domain and the bucket deployment are synth-checked (the template shape,
  `manifest.missing` empty, the absence of Secrets Manager, KMS, provisioned
  capacity), not run. Task 13 is where this meets AWS.
- **`SessionEnd` at the end of a cloud session.** Whether the hook gets to
  run when a remote session is torn down is not documented. The lease expiry
  (ten minutes) is the backstop, and Req 2 already treats it as the
  abandonment signal.
- **`npm stage publish` for a package that does not yet exist.** npm's
  documentation does not say whether a trusted publisher can be configured
  before the first version exists, and whether staging creates the `0.0.0-stage`
  placeholder the sibling pipeline's notes warn of cannot be tested without
  publishing. `docs/release-setup.md` bootstraps with a short-lived
  `NPM_TOKEN` environment secret and names the placeholder risk.
- **The GitHub workflows on a runner, and the GitHub App.** The file
  structure and rules are tested; the runs are not. The first `changelog.yml`
  run needs the app, its two secrets and a `v0.*` tag (`docs/release-setup.md`).
- **Drag on a touch screen.** The board was loaded in Chromium against the real
  Lambda router and DynamoDB Local and dragged with a mouse (desktop viewport,
  light and dark), screenshotted at a 390-pixel emulated touch viewport, and
  its drag logic is covered with synthetic pointer events in jsdom. A real
  finger on a real phone was not used.

## Deviations

Where the build differs from the text above. None changes a requirement.

1. **Three indexes, not two.** `GSI3` (attention view) is a sparse index on
   cards whose last agent has not acknowledged a human event since, or that a
   human moved back (`reopened`), keyed by `lastAgentId`. `GET /cards?attention=me` reads it in
   one query instead of scanning a repo's cards (Req 3.5). `GSI1` also holds the
   project and agent lists. Still on demand and AWS-owned key.
2. **Route prefixes.** The API is `/api/human/*` and `/api/agent/*` (design
   point 1), not one `/api/*` with a mixed authorizer. The paths in the API
   table are relative to the prefix.
3. **More error codes.** Added `repo_mismatch` (a worktree's repo differs from
   the card's), `name_taken` (a second project of the same name),
   `invalid_request`, `not_found`, `unauthorized`, `forbidden`, `conflict` and
   `internal`. Every error body is `{ code, message, card?, claim?, seq?,
   project? }` and every `message` says what to do next (Req 7.4).
4. **Stop is `SessionEnd`.** The skill's stop hook is registered under
   `SessionEnd` with a `timeout` of 20, not `Stop`, for the reason under
   "Verified". The script is still named `stop.sh`.
5. **`take` moves the card.** `take` also moves a card still in `backlog` or
   `ready` to `in_progress` (`--to` picks another non-review column,
   `--no-move` keeps it where it is); the server only advances a card forward
   on a claim, never back. `--to in_review` and `--to done` are refused (400),
   by the CLI and by the route: a claim that moved a card into review would
   leave a live claim there past any comment the agent has not read. The way
   into review is `pass`, which checks for unread comments.
6. **`check` with no card is the attention list; `ack` records the sequence
   `check <card>` showed.** Without `--seq`, `ack` acknowledges the sequence
   the last `check <card>` in this worktree printed, so a comment that arrives
   between the check and the ack stays unread and `pass` is refused again.
7. **Project resolution only where needed.** The CLI resolves a project from
   the repo map for `list`, `create`, `take` and the attention list. A command
   about a named card does not look up the project: the card already names it.
8. **Token and address sources.** The CLI also reads the board address from
   SSM `/baton/url` when `BATON_URL` is not set, and the parameter names can
   be overridden with `BATON_SSM_TOKEN_PARAM` and `BATON_SSM_URL_PARAM`. The
   hooks take `BATON_CLI` to override the pinned package spec.
9. **Credentials from a provider chain use the `aws` command.** See "Verified".
   The package still has no runtime dependency.
10. **`verbatimModuleSyntax` is off for the library build only**, so `lib/` is
    CommonJS and `__dirname` is available (design point 4). Everything else in
    the workspace keeps it on.
11. **Version pins in the reference skill and hooks** are rewritten by
    `scripts/set-version.ts` as part of every release, so the copies and the
    CLI they name cannot drift. The real skill lives in `claude-plugins`
    (task 11) and takes the version by hand.
12. **A local development server.** `pnpm dev` runs the router over DynamoDB
    Local with the built web app and no sign-in (every request is made by a
    fixed test user), with `--seed` for a demo board in every card state. It is
    for trying the app and for the browser check; it is not shipped.
13. **The distribution sits with the bucket, not in the certificate stack.**
    The first plan put `BatonDistribution` in the us-east-1 certificate stack,
    as tributary does with its edge. That cannot synthesise here: the bucket
    policy that admits the distribution (Origin Access Control) names the
    distribution, and the distribution names the bucket, so the stack holding
    the bucket and the stack holding the edge each depend on the other and
    synthesis fails with "BoardStack depends on EdgeStack ... would create a
    cyclic reference". `BatonBoard` therefore builds the distribution in its
    own stack; only the certificate, the zone and the web ACL's ARN cross
    from us-east-1, through `crossRegionReferences`.

## Advisor review rubric

Residue requirements and what the reviewer judges them against:

- Req 8.5, `SKILL.md`: an agent reading only the skill performs the full loop
  in the right order; a reviewer walks it as a new session would.
- Req 6.1, board legibility: the four card states plus `reopened` and `unread`
  are distinguishable at a glance in light and dark; stale and unowned are
  not mistaken for claimed.
- Req 10.4, dashboard legibility: a project needing a human (stale, unowned,
  reopened) stands out from one that is simply busy, on one screen at twenty
  projects.
- Req 7.4, error payloads: each refusal tells the agent what to do next
  without reading the API doc.

Everything else is encodable and lands in the acceptance battery (task 1).
