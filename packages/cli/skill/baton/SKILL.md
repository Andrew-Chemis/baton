---
name: baton
description: Use before editing code in a repo that has a Baton board. Lists the repo's cards, takes one so no other agent builds the same thing, reads what humans said, and passes the card to review or drops it. Triggers on starting a task, resuming work, or finishing one.
---

# Baton

A board of cards with one owner at a time. You take a card before you edit, humans steer by comment, and you hand the card on when done. Every command prints JSON; a refusal's `message` says what to do next, so do that.

`baton` is `npx --yes @andrewchemis/baton-cli@0.0.0`. It needs `BATON_URL` and `BATON_TOKEN` (or AWS credentials that can read the SSM parameters `/baton/url` and `/baton/agent-token`). Run it from the git checkout you work in: it reads repo, worktree and branch from git.

## The loop

1. `baton check` first. It lists cards you were last on that need you: human comments you have not acknowledged, or a lease that went stale. Deal with those before new work.
2. `baton list` shows this repo's open cards. Pick one, or `baton create --title "..."` if the work has no card.
3. `baton take <card>` before you touch a file. The card is its id, `owner/name/slug`, or the slug. If it answers `claim_held`, someone else is on it: pick another card and do not edit for this one.
4. Read `pending` in the answer. Those are human comments and edits since you last acknowledged; they outrank the card text.
5. Work on a branch of your own for this card, in this worktree. One card per worktree. The heartbeat hook keeps the claim alive; without it run `baton heartbeat` every few minutes.
6. Before you finish: `baton check <card>`, read `pending`, answer with `baton comment <card> "..."`, then `baton ack <card>`. `ack` records what that `check` showed, so a comment that arrived after it stays unread and `pass` is refused again; check and ack once more.
7. `baton pass` releases the card as done and moves it to In review (`--to done` or another column if told to). Add `--comment` with what changed and how you tested it.
8. Stopping early: `baton drop --reason paused --comment "what is left"`, or `--reason blocked` with what you are waiting for. Never walk away holding a card. The stop hook drops with `session_ended` if you cannot.

## Rules

- No card, no edits. Never work on a card you do not hold, and never retry a `claim_held` hoping it clears.
- `taken over` means your lease ran out and another agent holds the card now. Stop, `baton check`, and ask in a comment before touching its branch.
- A card that comes back from a human (moved to an earlier column) is marked reopened: read its comments first, the earlier work was not accepted.
- A refusal is the answer, not an error to route around. `unacked_comments`: check, read, ack, pass again. `repo_unregistered`: `baton project register --name "<project>"`.
- Exit 0 done, 1 the board refused or could not be reached (repeating the command is safe), 2 the command could not start (not a git checkout, no token).
