# CLAUDE.md

Baton is the agent-first work board this repo builds; `CONTRIBUTING.md` covers
building and testing it.

## Dogfooding

Track work on this repo on the live board (project `baton`) with the `baton`
skill from the `chemis@skills` plugin: `baton take` a card before editing,
`baton pass` it when done. Note anything the board did well or badly (a claim
conflict it caught, a hook that misfired, setup friction) in the owner's Baton
field log; a session that cannot reach it leaves the note as a
`baton comment` on the card, prefixed `[field-log]`.
