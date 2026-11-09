# Design — Baton

Requirements: `requirements.md`. Goals: `intent.md`. Research: none yet; the
facts under "Unverified" need a `research.md` pass before task 2.

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
| Card        | `CARD#<id>`     | `META`              | `BOARD#main` / `COL#<col>#<pos>` | `REPO#<repo>` / `CARD#<id>` |
| Event       | `CARD#<id>`     | `EVT#<seq, 8 digits>` |                              |                         |
| Key         | `KEY#<repo>/<slug>` | `META`          |                                |                         |
| Agent       | `AGENT#<id>`    | `META`              |                                |                         |
| Token       | `TOKEN#<sha256>`| `META`              |                                |                         |
| Idempotency | `IDEM#<actor>#<key>` | `META`         |                                |                         |

Card attributes: `id`, `key?`, `title`, `body`, `repo`, `column`, `pos`
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
| `GET /cards?repo=&column=&archived=` | both | board or repo listing, staleness computed |
| `GET /cards?attention=me` | agent | cards whose `lastAgentId` is the caller and that are `reopened` or have `lastHumanSeq > ackedSeq` (Req 3.5) |
| `POST /cards` | both | create; `key` dedupes (Req 5.4) |
| `GET /cards/{id}` | both | card with claim and staleness |
| `PATCH /cards/{id}` | both | title, body, links; `edited` event |
| `POST /cards/{id}/move` | both | `{ to, pos }`; reopen and done rules |
| `POST /cards/{id}/comments` | both | `commented` event |
| `GET /cards/{id}/events?since=` | both | events after `since` (Req 3.2) |
| `POST /cards/{id}/claim` | agent | conditional claim (Req 1) |
| `POST /cards/{id}/heartbeat` | agent | extend lease (Req 2.1) |
| `POST /cards/{id}/ack` | agent | `{ seq }` (Req 3.3) |
| `POST /cards/{id}/release` | agent | `{ reason, to? }` (Req 2.4) |
| `POST /cards/{id}/archive` | human | hide from board |
| `GET/POST/DELETE /agents`, `/agents/{id}/tokens` | human | agent identities and tokens (Req 7.1) |

Errors: `{ code, message, card? }` with codes `claim_held`, `not_holder`,
`seq_ahead`, `unacked_comments`, `missing_worktree`, `token_revoked`,
`idempotent_replay`. A listing marks each card `state: claimed | stale |
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
SPA rewrite by CloudFront Function, `/api/*` to the HTTP API. One board page:
columns, drag with pointer events, a card drawer for body, events and a
comment box, a repo filter, an agents page for tokens. It polls `GET /cards`
every 15 seconds; no WebSocket. Card badges: owner and branch, stale (lease
expired), unowned (in-progress column, no claim), reopened, unread (owner's
`ackedSeq < seq` of the latest human event).

## Skill

`plugins/skills/skills/baton/` in `claude-plugins`: `SKILL.md`,
`hooks/heartbeat.sh`, `hooks/stop.sh`. The CLI itself is the published
`@andrewchemis/baton-cli`; the hooks and the skill call it through `npx` at a
pinned version, so the plugin ships no copy of it. The CLI resolves repo from
the origin
URL, worktree from `git rev-parse --show-toplevel`, branch from `git
rev-parse --abbrev-ref HEAD`, and session from `CLAUDE_SESSION_ID` when set.
`take` writes `.git/baton-card` (worktree-local) so the hooks know which
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
table, user pool, HTTP API, Lambda and SPA bucket, and `BatonDistribution`,
the CloudFront piece, so a consumer can place the edge in its certificate
stack the way tributary does (the bucket and API URL cross regions through
`crossRegionReferences`, as tributary's do). Props: `domainName`, `certificate`,
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
`CertificateStack` (us-east-1) holds the delegated zone, certificate, web
ACL and `BatonDistribution`; its app stack (us-west-2) holds `BatonBoard`.
Config in its `app-config.ts`, deploy through `HardenedGitHubWorkflow` and
the landing-zone role, table and pool retained with deletion protection. A
synth test asserts the two asset paths exist in the installed package, so a
broken tarball fails the consumer's CI rather than its deploy (Req 9.6).
Upgrading is a version bump in `.projenrc.ts` and `pnpm install`.

## Unverified

- Cognito machine-to-machine pricing and whether a plain Lambda authorizer
  is the cheaper path at this volume. Decides the agent auth section.
- HTTP API support for two authorizers on one API, chosen per route.
- `CLAUDE_SESSION_ID` availability in hooks across CLI, remote and project
  sessions; the fallback is a random id written to `.git/baton-card`.
- Whether a `Stop` hook reliably runs on remote-session end; if not, the
  lease expiry is the only abandonment signal, which Req 2 already covers.
- `npm stage publish` and trusted publishing for a brand-new package (lede
  needed a token for the first publish and notes a `0.0.0-stage` placeholder
  risk). Decides the bootstrap step in the publishing section.
- Whether `BucketDeployment` and `Code.fromAsset` resolve cleanly from a
  path inside `node_modules` under pnpm's global virtual store, which
  `andrewchemis.dev` uses.

## Advisor review rubric

Residue requirements and what the reviewer judges them against:

- Req 8.5, `SKILL.md`: an agent reading only the skill performs the full loop
  in the right order; a reviewer walks it as a new session would.
- Req 6.1, board legibility: the four card states plus `reopened` and `unread`
  are distinguishable at a glance in light and dark; stale and unowned are
  not mistaken for claimed.
- Req 7.4, error payloads: each refusal tells the agent what to do next
  without reading the API doc.

Everything else is encodable and lands in the acceptance battery (task 1).
