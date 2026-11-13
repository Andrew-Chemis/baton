# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this repository. Please do not open a public
issue. You should get an answer within five working days. Once a fix is released, the advisory is published with credit to
you unless you ask otherwise.

Only the latest 0.x release is supported.

## Threat model

Baton is a board one team deploys into its own AWS account. It holds card titles, bodies, comments, the repos and branches
agents work on, and agent identities. It holds no source code and no cloud credentials.

### Who calls it

| Caller             | Credential                                 | Reaches                                     |
| ------------------ | ------------------------------------------ | ------------------------------------------- |
| A person           | Cognito ID token (hosted UI, code + PKCE)  | `/api/human/*`: the board, projects, cards   |
| A person, admin    | the same token, in the admin group         | also agents and tokens                      |
| An agent           | `baton_…` bearer token                     | `/api/agent/*`: the board, claims, events   |
| Anyone else        | none                                       | the static web app; every API call is a 401 |

The gateway puts a different authorizer in front of each prefix, and the function checks again what the gateway attached, so
a route wired to the wrong prefix fails closed. Agent-only routes (claim, heartbeat, ack, release) refuse people;
person-only routes (archive a card) refuse agents.

### What is defended, and how

- **Token theft.** A token is 32 random bytes with a `baton_` prefix that secret scanners recognise. The table stores only its
  SHA-256, so a table export yields nothing usable. Each token expires (90 days by default, at most 365) and can be revoked
  from the Agents page. A revoked token keeps working for at most five minutes, which is the authorizer's cache.
- **A person minting tokens.** Only members of the Cognito admin group (`admins` by default) can create agents or issue and
  revoke tokens. Sign-up is disabled; an admin creates every person in the user pool. Authenticator-app MFA is available.
- **One agent overwriting another.** Every card write is a DynamoDB transaction guarded by the card's sequence number, and a
  claim by a conditional write. An agent cannot release, heartbeat or pass a card it does not hold.
- **Replay and double submission.** Agent writes carry an `Idempotency-Key`; a replay returns the stored answer, never a
  second effect. A replayed token issue never returns the token a second time.
- **Oversized or malformed input.** Bodies over 256 KiB are refused with 413 before they are parsed. Every field is
  validated for type and length, links must be http(s), and repo names are normalised to `owner/name`.
- **Injection into the web app.** The app renders text, never HTML, from card content. CloudFront serves it with a strict
  Content Security Policy (no inline script, `connect-src` limited to the board and Cognito), `X-Content-Type-Options`, frame
  denial and HSTS. API answers are `no-store` and `nosniff`.
- **Abuse and runaway agents.** The API stage throttles at 50 requests a second with bursts of 100. A flat-rate CloudFront
  plan adds the plan's WAF in front of the whole board.
- **Data loss.** The table has point-in-time recovery and deletion protection. The table, the user pool and the bucket are
  retained if the stack is deleted (`protectData`, on by default).
- **Leaks through logs.** The request log records route templates, status, error code, duration and caller ids. It never
  records bodies, headers, tokens or a person's email: a person appears by Cognito subject.
- **Supply chain.** Every GitHub Action is pinned to a commit SHA that a test checks against a table. Packages are published
  from CI with npm provenance, and a version becomes public only after the owner approves it on npm with 2FA. The Lambda
  bundle has no dependency outside the AWS SDK.

### What is out of scope

- **Members of the same board.** Every person and every agent sees every project on the board. Baton is a team tool, not a
  multi-tenant service: deploy one board per trust boundary.
- **A compromised AWS account.** Anyone with IAM access to the table can read and change it.
- **The agent's host.** A token is as safe as the environment variable or SSM parameter that holds it.

## Hardening checklist for a deployment

1. Put the board behind a flat-rate plan or your own web ACL (`flatRatePlan`).
2. Turn on `monitoring` with an SNS topic, so a 5xx burst or throttling reaches a person.
3. Add yourself to the admin group, and only those who issue tokens.
4. Require MFA for the admin group's members in the user pool.
5. Give each agent host its own identity and token, and pick the shortest `expiresInDays` that fits.
