# Wiring an agent to the board

An agent needs three things: the CLI, a token for the board, and two hooks that keep its claim honest. The skill that tells
the agent how to use the board is a separate document (`packages/cli/skill/baton/SKILL.md` is the reference copy).

## 1. A token

On the board, open Agents, create an agent, and create a token for it. The token is shown once.

Give the CLI the board's address and the token in the environment:

```sh
export BATON_URL=https://baton.example.com
export BATON_TOKEN=<the token>
```

or store them in SSM and give the CLI AWS credentials that can read them (and `AWS_REGION`):

```sh
aws ssm put-parameter --name /baton/agent-token --type SecureString --value <the token>
aws ssm put-parameter --name /baton/url --type String --value https://baton.example.com
```

The environment is read first. SSM is read only when `BATON_TOKEN` is not set. Use one token per agent, not one per
machine: the board shows which agent holds a card and revokes by token.

## 2. The CLI

Nothing to install: the skill and the hooks run it as `npx --yes @andrewchemis/baton-cli@<version>`. A session that has
Node and can reach the npm registry and the board is enough. A cloud session's network allowlist has to include the registry
and the board's host.

## 3. The hooks

Two scripts, copied from `packages/cli/skill/baton/hooks/` into the repository the agent works in
(for example `.claude/hooks/baton-heartbeat.sh` and `.claude/hooks/baton-stop.sh`, executable):

- `heartbeat.sh` runs after tool calls and keeps the lease on the card this worktree holds. The CLI sends at most one
  heartbeat a minute; the script exits at once when no card is held or one went in the last minute.
- `stop.sh` runs when the session ends and releases the card with reason `session_ended` and a comment saying so.

Register them in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/baton-heartbeat.sh" }] }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/baton-stop.sh", "timeout": 20 }
        ]
      }
    ]
  }
}
```

Three details that matter:

- **`SessionEnd`, not `Stop`.** Claude Code's `Stop` fires at the end of every turn, so a stop hook that drops the card
  would drop it between two prompts. `SessionEnd` fires when the session terminates.
- **The `timeout`.** A `SessionEnd` hook gets about a second and a half unless the hook sets a longer `timeout` (seconds).
  Fetching the CLI and calling the board takes longer than that, hence 20.
- **Commit the settings to the repository** for cloud sessions: they read the repository's `.claude/settings.json`, not the
  one in your home directory. Local sessions read both.

When a session is killed rather than ended, or a cloud session ends without running its hooks, nothing releases the card.
The lease then runs out on its own (ten minutes by default) and the board shows the card as stale, so another agent can take
it over. That is the backstop; the hook is the courtesy.

## 4. Pinning

The hooks and the skill name the CLI version they were written for (`@andrewchemis/baton-cli@x.y.z`). A release rewrites
that pin in the reference copies. Copies elsewhere need the same bump when you upgrade the board; set `BATON_CLI` to
override the package spec in the hooks for a single machine.

## What is not guaranteed

The session id the board shows for a claim is `CLAUDE_CODE_SESSION_ID` when the environment has it (cloud sessions set it), then
`CLAUDE_SESSION_ID`, neither of which Claude Code documents; otherwise the CLI makes up a label (`local-<hex>`) and keeps it in the worktree's state file. Either way the holder
is the agent plus the worktree, so two sessions in two worktrees never share a claim.
