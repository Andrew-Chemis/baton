# Intent — Baton, the agent-first work board

## Outcome

Every agent working in this account's repos claims its task on one shared
board before it edits a file, keeps the claim alive while it works, and reads
the human's moves and comments back before it calls anything done, so no two
agents build the same thing and no task is started and quietly dropped.

## Why now

Work now runs across several repos, several worktrees and several concurrent
Claude sessions (project threads, remote sessions, local CLI). The only record
of who is doing what is each session's own context, which dies with the
session. That has two costs today: a second agent re-implements a feature
another agent has half-finished in a different worktree, and a task that stalls
when its session ends leaves no trace that anyone owed it. A human cannot see
either happening. One live, remote store of task state that both humans and
agents treat as the source of truth closes both gaps, and a kanban board is the
view a human already knows how to read and edit. The name is the metaphor:
work is a baton that passes from session to session, and a dropped one shows.

## Done means

- An agent starting a task finds out, from the board alone, that the task is
  already claimed, by which agent, in which repo and worktree, and how recently
  that agent was heard from, and stops.
- A task whose agent stops reporting becomes visibly stale on the board within
  minutes, without anyone noticing by hand, and can be re-claimed.
- A human can drag a card to another column or leave a comment, and the agent
  that owns the card sees exactly that change the next time it checks, as a
  change, not as current state it has to diff itself.
- A card moved backward by a human (done to in review, in review to in
  progress) makes the owning agent treat the work as incomplete and reopen it,
  and a comment on a card reaches the agent as something it must respond to.
- Two agents in two worktrees of the same repo cannot both hold an active
  claim on the same card, and a claim records the worktree and branch so a
  later agent can resume from the right place rather than start over.
- A human looking at the dashboard sees every project being worked on and,
  per project, how much is claimed, stale, unowned or waiting on them, and
  one click opens that project's board. No agent is asked.
- Registering a new project is one action from the dashboard or one command
  from a checkout, and cards from that repo land on its board from then on.

## Non-goals

- Multi-tenant or multi-user access control beyond one Cognito user pool; one
  user today, the design leaves room for more without building it.
- Replacing GitHub issues or PRs as the record of the work itself. The board
  tracks state and ownership and links out; code review stays on GitHub.
- Real-time push to agents (WebSockets, subscriptions). Agents poll on their
  own cadence; the board is correct whenever it is read.
- Time tracking, estimates, burndown, sprints or any reporting beyond the
  board itself.
- Running or spawning agents. The board records and arbitrates; it never
  starts work.

## Constraints

- Stack is fixed: DynamoDB for state, API Gateway for the agent and browser
  API, Cognito for human sign-in, S3 plus CloudFront for the board UI. Cost
  policy from `andrewchemis.dev` applies: pay per request, no standing charges
  beyond CloudFront's flat-rate plan, SSM over Secrets Manager, AWS-owned keys.
- Agents authenticate without a browser. Whatever credential an agent holds
  must work from a headless remote session and a local CLI alike.
- Every write an agent makes must be safe to repeat: a retried claim, a
  re-sent heartbeat or a duplicated comment must not create a second claim or a
  second card.
- Claiming must be atomic at the store. Two agents racing for one card get
  one winner, decided by DynamoDB, never by the client.
- Agent-side integration is one skill or CLI that any repo's agent can call,
  so adopting the board in a repo adds a dependency and a few lines, not a
  service.
- The code is open source in its own public repo and carries nothing
  account-specific: no account ids, domains, role ARNs or zone ids. Those live
  in the consuming app.
- The board is consumed as published npm packages, so `andrewchemis.dev`
  deploys it through its existing pipeline as one more workspace app, with
  the usual CDK, projen and `HardenedGitHubWorkflow` conventions, to
  us-west-2 through a landing-zone account. Public npm, not GitHub Packages:
  a remote session must be able to install it.
- Releases follow lede's model: changelog and version from Conventional
  Commits, npm trusted publishing with provenance, a manual approval before
  anything is public.

## Open

- How stale is stale: the heartbeat interval and the lease length before a
  claim can be taken over. Non-blocking; a default of a few minutes is
  assumed until measured.
- Whether a claim should bind to a branch name, a worktree path, or both.
  The design records both and warns on branch reuse; whether that is enough
  is non-blocking and waits on use.
