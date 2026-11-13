#!/bin/sh
# SessionEnd hook for Baton: releases the card this worktree holds, reason session_ended, with a comment saying so.
# Wire it under "SessionEnd", not "Stop": Stop fires at the end of every turn, and that would drop the card between prompts.
# SessionEnd hooks get a 1.5 second budget unless the hook sets a longer "timeout"; set 20. --prefer-offline uses the copy
# the heartbeat hook already fetched. If this does not run (a killed session, a cloud session ending), the lease expires
# on its own after ten minutes and the card shows as stale. Wiring: docs/agents.md in the Baton repository.
cli="${BATON_CLI:-@andrewchemis/baton-cli@0.1.1}"
state=$(git rev-parse --git-path baton-card 2>/dev/null) || exit 0
[ -f "$state" ] || exit 0
npx --yes --prefer-offline "$cli" hook stop || true
exit 0
