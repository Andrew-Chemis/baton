# Requirements — Baton

Scope: a board service (DynamoDB, API Gateway, Cognito, S3, CloudFront)
published as npm packages from a public repo, one agent-side skill that calls
it, and the release pipeline that lets the `andrewchemis.dev` pipeline consume
it. Goals and boundaries: `intent.md`.

Vocabulary: a **card** is one unit of work. A **claim** is an agent's lease on
a card, carrying the agent id, repo, worktree and branch, and expiring at
`leaseUntil` unless renewed by a **heartbeat**. An **event** is one append-only
change to a card (move, comment, claim, release, edit) with a per-card
sequence number. A card is **stale** when its claim's lease has expired. A
card's **last agent** is the agent that most recently held it, claim or not.

## Requirement 1: one claim per card, decided by the store

**User story:** As an agent starting a task, I want to know before I edit a
file whether another agent already holds it, so I never build what someone else
is building.

Acceptance criteria:

- WHEN an agent claims a card with no active claim THE SYSTEM SHALL record the
  claim with agent id, repo, worktree, branch, session label and `leaseUntil`,
  and append a `claimed` event.
- WHEN two agents claim the same card concurrently THE SYSTEM SHALL grant
  exactly one, using a DynamoDB conditional write, and SHALL return to the
  loser the winner's agent id, worktree, branch and last heartbeat time.
- WHEN an agent claims a card whose claim is held by a different agent and not
  yet expired THE SYSTEM SHALL refuse and return that claim.
- WHEN an agent claims a card it already holds THE SYSTEM SHALL succeed without
  a second claim or a second event.
- WHEN an agent claims a card whose claim has expired THE SYSTEM SHALL grant
  it and append a `taken_over` event naming the previous agent.

## Requirement 2: a stalled agent becomes visible without anyone looking

**User story:** As the human, I want a card whose agent went quiet to show as
stale on the board, so work that stopped is never mistaken for work in
progress.

Acceptance criteria:

- WHEN an agent sends a heartbeat for a card it holds THE SYSTEM SHALL extend
  `leaseUntil` by the lease length and record `heartbeatAt`, appending no event.
- WHEN a heartbeat arrives from an agent that does not hold the card THE SYSTEM
  SHALL refuse it.
- WHEN a card's `leaseUntil` is in the past THE SYSTEM SHALL report it as stale
  in every read, computed at read time, with no scheduled job.
- WHEN an agent releases a card THE SYSTEM SHALL clear the claim, append a
  `released` event with the agent's stated reason (`done`, `paused`,
  `blocked`, `session_ended`) and leave the card in its column unless the
  release names a new one.
- THE SYSTEM SHALL show an unclaimed card in an in-progress column as
  `unowned`, distinct from stale and from claimed.

## Requirement 3: human edits reach the agent as changes

**User story:** As the human, I want a move or a comment I make to reach the
owning agent the next time it checks, so I can steer work without a chat
session.

Acceptance criteria:

- WHEN a human moves a card, comments on it or edits its title or body THE
  SYSTEM SHALL append an event with actor, type, timestamp and payload, and
  increment the card's sequence.
- WHEN an agent asks for changes on a card since sequence N THE SYSTEM SHALL
  return every event after N in order, and SHALL include the full comment text
  for comment events.
- WHEN the holder or last agent acknowledges sequence N THE SYSTEM SHALL record
  it on the card, and SHALL refuse an acknowledgement of a sequence the card
  has not reached.
- THE SYSTEM SHALL show on the board, per card, whether the last agent has
  acknowledged the latest human event.
- WHEN an agent asks for its attention list THE SYSTEM SHALL return every card
  whose last agent it is that is `reopened` or has a human event after its
  acknowledgement, so a passed card that a human moved back or commented on
  reaches the agent without a card id.

## Requirement 4: a backward move means the work is not done

**User story:** As the human, I want dragging a card from Done back to In
review to tell the agent its work is incomplete, so a half-finished task does
not stay marked finished.

Acceptance criteria:

- THE SYSTEM SHALL order columns, and WHEN a human moves a card to a column
  earlier in that order THE SYSTEM SHALL mark the card `reopened` and append a
  `moved` event carrying the from and to columns.
- WHEN an agent reads a reopened card THE SYSTEM SHALL return `reopened: true`
  until an agent claims it, after which the flag clears.
- WHEN a human moves a card to Done THE SYSTEM SHALL clear any claim and
  append a `released` event with reason `human_done`.
- WHEN an agent moves a card to In review or Done while a human event is
  unacknowledged THE SYSTEM SHALL refuse the move and name the unacknowledged
  sequence.

## Requirement 5: cards and claims know their worktree

**User story:** As an agent, I want to see which worktree and branch hold a
card, so I resume in the right place instead of starting a second copy.

Acceptance criteria:

- THE SYSTEM SHALL require `repo`, `worktree` and `branch` on every claim and
  reject one that lacks any of them.
- WHEN an agent claims a card with a branch that holds an active claim on
  another card in the same repo THE SYSTEM SHALL succeed and return a warning
  naming that card.
- WHEN an agent lists cards for a repo THE SYSTEM SHALL return, for each
  claimed card, its worktree, branch, agent id and whether it is stale.
- THE SYSTEM SHALL support a card `key` (`<repo>/<slug>`) unique per board, and
  WHEN a card is created with a key that exists THE SYSTEM SHALL return the
  existing card instead of creating one.

## Requirement 6: the board is one page for every repo

**User story:** As the human, I want to see all in-flight work on one page and
move cards by dragging, so I know where everything is without asking an agent.

Acceptance criteria:

- THE SYSTEM SHALL render every card on one page grouped by column, with the
  repo, claim owner, staleness, `reopened` and unacknowledged-comment states
  visible on the card.
- WHEN the human drags a card to another column or position THE SYSTEM SHALL
  persist the move within one request and show it on the next poll.
- THE SYSTEM SHALL let the human add a comment, edit title and body, create a
  card and archive a card from the page.
- THE SYSTEM SHALL filter by repo and hide archived cards by default.
- THE SYSTEM SHALL require a Cognito sign-in for the page and every human API
  call, and SHALL use one user pool.

## Requirement 7: agents authenticate headlessly and writes are idempotent

**User story:** As an agent in a remote session, I want to call the board with
one token and retry freely, so a flaky network never creates a duplicate.

Acceptance criteria:

- THE SYSTEM SHALL accept a bearer token per agent identity, issued and revoked
  from the board page, stored only as a hash, and SHALL reject a revoked token
  within five minutes of revocation.
- THE SYSTEM SHALL accept an `Idempotency-Key` header on every write, and WHEN a
  key is repeated within 24 hours THE SYSTEM SHALL return the first response
  without a second write.
- THE SYSTEM SHALL distinguish human and agent actors on every event.
- THE SYSTEM SHALL return a machine-readable error code and the conflicting
  claim or sequence on every refusal.

## Requirement 8: adopting the board in a repo is a skill, not a service

**User story:** As an agent in any of this account's repos, I want one skill
that claims, heartbeats, checks and releases, so following the board costs a
few lines.

Acceptance criteria:

- THE SYSTEM SHALL ship a CLI with `list`, `create`, `take`, `heartbeat`,
  `check`, `ack`, `comment`, `move`, `pass` and `drop`, each printing JSON.
  `take` claims a card, including one whose lease has expired; `pass` releases
  it and moves it on (to `in_review` unless `--to` names a column); `drop`
  releases it in place with a reason (`paused`, `blocked`).
- THE SYSTEM SHALL detect repo, worktree and branch from the current git
  checkout and SHALL fail with a named cause when outside one.
- THE SYSTEM SHALL read its token and endpoint from the environment, and
  SHALL fall back to an SSM SecureString parameter when AWS credentials exist.
- THE SYSTEM SHALL provide a heartbeat hook that runs on tool use at most once
  per minute, and a stop hook that releases the card with reason
  `session_ended` and a comment when a session ends holding a claim.
- THE SYSTEM SHALL ship a `SKILL.md` that tells an agent to list and take
  before editing, to check and ack before passing to In review or Done, and
  to drop on stop.

## Requirement 9: the main app repo consumes the board from npm

**User story:** As the owner, I want `andrewchemis.dev` to deploy the board
by depending on a published package, so the open-source repo holds the code
and the private repo holds only my account's wiring.

Acceptance criteria:

- THE SYSTEM SHALL publish a CDK construct package that deploys the whole
  board from one construct given a domain, certificate and hosted zone, with
  the API Lambda bundle and the built web app inside the tarball, so the
  consumer builds neither.
- THE SYSTEM SHALL publish the agent CLI as a second package with a `bin`,
  runnable with `npx` or installed, and SHALL keep the two on one version.
- THE SYSTEM SHALL contain no account id, domain, role ARN, zone id or
  hosted-zone name in the published packages or workflows; a check in CI SHALL
  fail on any 12-digit account-shaped number, `arn:aws:` or the owner's domain
  under `packages/` (outside tests) or `.github/`.
- WHEN a commit lands on `main` THE SYSTEM SHALL compute the next version from
  Conventional Commits, write the changelog and publish a GitHub release;
  WHEN that release is published THE SYSTEM SHALL build, test, pack and stage
  both packages on npm with provenance via trusted publishing, and SHALL make
  nothing public without the owner's approval of the `npm` environment.
- THE SYSTEM SHALL pin every action by SHA and SHALL run the publish job with
  no checkout and no repository code.
- WHEN the consuming app bumps the package version THE SYSTEM SHALL require
  no change beyond the version and `pnpm install`; a synth test in the consumer
  SHALL fail if the construct's assets are missing from the tarball.
