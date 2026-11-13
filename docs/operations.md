# Operating a board

What to watch, what each alarm means, and how to recover. Everything here assumes the stack from `BatonBoard`; names are
`<prefix>-…`, `baton-…` by default.

## Turn on monitoring

```ts
const topic = new Topic(stack, 'BoardAlerts');
topic.addSubscription(new EmailSubscription('oncall@example.com'));

new BatonBoard(stack, 'Board', {
  domainName: 'baton.example.com',
  certificate,
  hostedZone,
  metrics: true,
  monitoring: { alarmTopic: topic, dashboard: true },
});
```

Cost: six alarms, about $0.10 a month for each metric they watch (the two table alarms watch three metrics each), four
custom metrics at about $0.30 each, and a dashboard at $3 beyond the account's free three. Logs bill by the gigabyte
ingested; one request line is about 300 bytes.

## Where to look

| Question                                       | Where                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| What happened to request X?                    | Function log group, `filter requestId = "X"`; the access log has it too   |
| Why did an agent get refused?                  | Function log, `filter msg = "request" and status >= 400`, by `code`       |
| Was a request turned away before the function? | Access log, `filter ispresent(authorizerError) and authorizerError != "-"` |
| Which routes are slow?                         | Function log, `stats pct(durationMs, 99) by route`                        |
| How many claims are contested or abandoned?    | Metrics `Baton/ClaimRefused` and `Baton/ClaimTakenOver`                   |
| What schema version is the table at?           | Table item `PK = SCHEMA`, `SK = META`: `version` and `history`            |

A 500 answer quotes its request id in the message, so an agent's transcript or a person's screenshot leads straight to the
log line and the stack trace beside it.

## Alarms

| Alarm               | Fires when                                  | First steps                                                                                                                                                       |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Api5xx`            | 5 or more 5xx answers in 5 minutes          | Function log, `level = "ERROR"`. Every 500 has a stack trace logged with its request id. A burst right after a deploy points at the deploy: roll back (below).     |
| `LambdaErrors`      | The function crashed or timed out           | The handler answers its own errors, so this is a timeout (10 s) or a failure at start-up, such as a missing `BATON_TABLE`. Look at the `REPORT` and `INIT` lines. |
| `LambdaThrottles`   | The account's concurrency limit was reached | Another function in the account is using it, or an agent is looping. The access log's `ip` and the request log's `actor` show who.                                 |
| `LatencyP99`        | p99 above 3 s for 15 minutes                | `stats pct(durationMs, 99) by route`. A slow board listing means a project with thousands of live cards: archive done cards.                                       |
| `TableThrottles`    | DynamoDB throttled a request                | On demand only throttles past the table's previous peak doubling, or a hot partition. Check `ConsumedWriteCapacityUnits`, and the busiest card in the log.         |
| `TableSystemErrors` | DynamoDB answered with a 5xx                | An AWS-side problem. Check the AWS Health Dashboard. Agents retry with the same idempotency key, so no work is lost.                                              |

## Runbooks

### Revoke a leaked token

On the Agents page, revoke it. It stops working within five minutes (the authorizer's cache), and the agent gets
`token_revoked`. To stop it at once, also delete the agent: that revokes every token it has. Then issue a new token where the
agent runs. No board admin? Any member of the admin group can do it; add one in the user pool (below).

### Add or remove an admin

```sh
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username <email> --group-name admins
aws cognito-idp admin-remove-user-from-group --user-pool-id <UserPoolId> --username <email> --group-name admins
```

The change applies at the person's next sign-in, when their ID token is reissued (at most an hour).

### Add a person

Sign-up is off. Create them in the user pool, which emails a temporary password:

```sh
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <email> \
  --user-attributes Name=email,Value=<email> Name=email_verified,Value=true
```

### A card is stuck with a claim nobody holds

Nothing to do: when the lease ends (ten minutes without a heartbeat) the card shows as stale and any agent may take it over,
which is recorded on the card. A person can also move it to Done or archive it, which ends the claim.

### A deploy failed during migrations

The custom resource `Custom::BatonSchema` runs the migrations. CloudFormation rolls the stack back; the table stays at the
last migration that finished (`history` on the `SCHEMA` item says which). Look in the function log for the migration's
error, fix it, and deploy again: the run resumes at the migration that failed. If a run died while holding its lock, the
next one waits out the 15-minute lock, or remove `lockedUntil` from the `SCHEMA` item by hand.

Migrations only add or rewrite derived fields, so the code before them keeps working on migrated data; a rollback of the
code alone is safe.

### Roll back a release

Deploy the previous `@andrewchemis/baton-cdk` version. The table, the user pool and the bucket are retained resources and do
not change. If the release raised the schema version, the older code ignores the newer fields (see above).

### Restore the table

Point-in-time recovery keeps 35 days. Restore to a new table, then point the stack at it:

```sh
aws dynamodb restore-table-to-point-in-time --source-table-name <TableName> \
  --target-table-name <TableName>-restored --restore-date-time 2026-11-01T12:00:00Z
```

A restore does not carry over TTL, point-in-time recovery or deletion protection; set them on the new table, or move the
data back with an export and import. Plan the switch-over for a quiet moment: agents' claims in the restored copy are as old
as the restore point, so they show as stale and are taken over cleanly.

## Limits worth knowing

- **Rate.** The API stage allows 50 requests a second, bursts of 100. One agent sends a heartbeat a minute and polls a few
  times a minute, so this is hundreds of concurrent agents.
- **A project's board is one query.** It reads every live card of the project, so keep it in the low thousands: archive
  done cards. Archived cards are on their own partition and cost nothing to a board read.
- **Events.** A card keeps every event. `GET /cards/{id}/events` pages them 200 at a time.
- **Bodies.** 256 KiB a request; 20,000 characters a card body, 10,000 a comment.
