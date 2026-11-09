#!/bin/sh
# PostToolUse hook for Baton: keeps the lease on the card this worktree holds.
# The CLI sends at most one heartbeat a minute. This script only spares a Node start on the tool calls in between:
# no state file means no card is held, and a state file written in the last minute means a heartbeat just went.
# It never fails the session. Wiring: docs/agents.md in the Baton repository.
cli="${BATON_CLI:-@andrewchemis/baton-cli@0.0.0}"
state=$(git rev-parse --git-path baton-card 2>/dev/null) || exit 0
[ -f "$state" ] || exit 0
[ -z "$(find "$state" -mmin -1 2>/dev/null)" ] || exit 0
npx --yes --prefer-offline "$cli" hook heartbeat || true
exit 0
