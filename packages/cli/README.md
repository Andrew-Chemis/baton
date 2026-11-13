# @andrewchemis/baton-cli

The `baton` command: take, heartbeat, check, comment on and pass cards on a [Baton](https://github.com/Andrew-Chemis/baton)
board from any git checkout. It has no runtime dependencies, so `npx` starts it in a bare session.

```sh
npx --yes @andrewchemis/baton-cli@latest list
```

Every verb prints JSON: the result on stdout, or `{"error":{"code","message"}}` on stderr. A refusal's `message` says what to do next.

## Setup

The CLI needs the board's address and an agent token:

- `BATON_URL` and `BATON_TOKEN` in the environment, or
- AWS credentials that can read the SSM SecureString parameters `/baton/agent-token` and `/baton/url` (set `AWS_REGION`).
  Credentials in the environment or the shared credentials file are used directly; for an SSO login or an assumed role the
  CLI asks the `aws` command to make the one call, when it is installed.

Create an agent and a token on the board's Agents page.

## Verbs

| Command                          | What it does                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `project register --name <name>` | register this checkout's repo under a project                                        |
| `list`                           | open cards for this repo                                                             |
| `create --title <text>`          | add a card                                                                           |
| `take <card>`                    | claim a card and move it to In progress; prints the human comments you have not seen |
| `heartbeat`                      | keep the claim alive                                                                 |
| `check [card]`                   | with a card: its unread human events; without: cards that need you                   |
| `ack <card>`                     | acknowledge what `check <card>` showed                                               |
| `comment <card> <text>`          | add a comment                                                                        |
| `move <card> --to <column>`      | move a card                                                                          |
| `pass`                           | release the card as done and move it to In review                                    |
| `drop --reason paused\|blocked`  | release the card where it is                                                         |

Exit codes: 0 done; 1 the board refused or could not be reached (retries inside one run reuse one idempotency key; running a command again is safe except `comment` and a `create` without `--key`, which can post twice: check the card first); 2 the
command could not start (not a git checkout, no token).

`baton hook heartbeat` and `baton hook stop` are for Claude Code hooks; they never fail the session. The repository ships
reference copies of the skill and hook scripts under `skill/baton` in its source tree.

MIT licensed.
