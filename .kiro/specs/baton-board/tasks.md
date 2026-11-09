# Tasks — Baton

Status: active

- [ ] 1. Compile acceptance checks <!-- pattern: advisor -->
  - R1.1-1.5 → claim tests: grant, concurrent race yields one winner, held
    refused with holder returned, re-claim idempotent, expired lease taken over
    with `taken_over` event
  - R2.1-2.5 → heartbeat extends and writes no event; non-holder refused;
    stale computed from `leaseUntil`; release reasons; `unowned` state
  - R3.1-3.4 → events appended with actor and seq; `events?since` ordering and
    comment text; ack bounds; unread flag in listing
  - R4.1-4.4 → backward move sets `reopened`; claim clears it; human done
    releases with `human_done`; agent done refused with `unacked_comments`
  - R5.1-5.4 → claim rejects missing worktree; branch-reuse warning; repo
    listing fields; key dedupe returns existing card
  - R6.5, 7.1-7.3 → routes reject without JWT or token; revoked token; replayed
    `Idempotency-Key` returns first body; actor kind on events
  - R8.1-8.4 → CLI subcommands print JSON; outside a git tree fails named;
    env then SSM token resolution; heartbeat hook throttles to one a minute;
    stop hook drops with `session_ended`; `pass` defaults to `in_review`
  - R9.1-9.3, 9.6 → pack test: tarball holds `lib/`, `assets/api/index.js`,
    `assets/web/index.html`; bin runs from the installed package; versions
    equal; string check fails on a planted account id in a fixture
  - R9.4-9.5 → workflow lint: every `uses:` pinned to a SHA; publish job has
    no checkout step and `id-token: write` only; `environment: npm` present
  - Synth test: `manifest.missing` empty; one Lambda asset; no Secrets Manager,
    no KMS key, no provisioned capacity in the template
- [ ] 2. Research the unverified facts in `design.md` and amend it <!-- pattern: solo -->
- [ ] 3. Repo scaffold: pnpm workspace, `packages/cdk` and `packages/cli`, oxlint, oxfmt, vitest, `ci.yml`, account-string check <!-- pattern: advisor -->
- [ ] 4. `BatonBoard` and `BatonDistribution` constructs: table, GSIs, TTL, user pool, HTTP API with both authorizers, Lambda from `assets/api`, SPA from `assets/web` <!-- pattern: advisor -->
- [ ] 5. Service: card, event and claim modules with the conditional writes and transactions <!-- pattern: advisor -->
- [ ] 6. Service: auth, idempotency, error codes, listing states <!-- pattern: advisor -->
- [ ] 7. Web app: board, drag, drawer, comments, repo filter, agents and tokens page <!-- pattern: advisor -->
- [ ] 8. CLI package: `bin`, git detection, token resolution, JSON output <!-- pattern: advisor -->
- [ ] 9. Build and pack: esbuild the Lambda and Vite the web app into `assets/`, `files` allowlists, pack test <!-- pattern: advisor -->
- [ ] 10. `changelog.yml` and `release.yml` with staged npm publishing; owner sets up the `npm` environment and trusted publishing <!-- pattern: solo -->
- [ ] 11. Skill in `claude-plugins`: `SKILL.md`, heartbeat and stop hooks calling the CLI <!-- pattern: advisor -->
- [ ] 12. Consumer: `apps/baton` in `andrewchemis.dev` on tributary's layout, config, pipeline, asset-path synth test <!-- pattern: advisor -->
- [ ] 13. Deploy through the `andrewchemis.dev` pipeline, seed the first agent token, run one real claim from a remote session <!-- pattern: solo -->
