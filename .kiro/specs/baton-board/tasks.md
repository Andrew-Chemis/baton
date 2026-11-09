# Tasks — Baton

Status: active

- [x] 1. Compile acceptance checks <!-- pattern: advisor -->
  - R1.1-1.5 → claim tests: grant, concurrent race yields one winner, held
    refused with holder returned, re-claim idempotent, expired lease taken over
    with `taken_over` event
  - R2.1-2.5 → heartbeat extends and writes no event; non-holder refused;
    stale computed from `leaseUntil`; release reasons; `unowned` state
  - R3.1-3.5 → events appended with actor and seq; `events?since` ordering and
    comment text; ack bounds and ack by last agent after `pass`; unread flag
    in listing; `attention=me` returns a passed card after a human comment
  - R4.1-4.4 → backward move sets `reopened`; claim clears it; human done
    releases with `human_done`; agent move to review or done refused with
    `unacked_comments`, and allowed after the agent's own comment
  - R5.1-5.4 → claim rejects missing worktree; branch-reuse warning; repo
    listing fields; key dedupe returns existing card
  - R6.2-6.4 → web component tests: a drop calls `move` once with the target
    column and `pos`; comment, edit, create and archive call their routes;
    repo filter and archived toggle
  - R6.5, 7.1-7.3 → routes reject without JWT or token; revoked token; replayed
    `Idempotency-Key` returns first body; actor kind on events
  - R8.1-8.4 → CLI subcommands print JSON; outside a git tree fails named;
    env then SSM token resolution; heartbeat hook throttles to one a minute;
    stop hook drops with `session_ended`; `pass` defaults to `in_review`
  - R10.1-10.3, 10.5 → register creates project and repo map in one
    transaction; second registration of a repo refused with `repo_taken`;
    card for an unmapped repo refused with `repo_unregistered`; card takes
    its repo's project; archive refused with `project_has_claims` while a
    claim exists; CLI `project register` adds the current repo
  - R10.4 → dashboard listing returns per-project counts that match a seeded
    board and the latest `lastEventAt`; archived projects absent
  - R9.1-9.3, 9.6 → pack test: tarball holds `lib/`, `assets/api/index.js`,
    `assets/web/index.html`; bin runs from the installed package; versions
    equal; string check fails on a planted account id in a fixture
  - R9.4-9.5 → workflow lint: every `uses:` pinned to a SHA; publish job has
    no checkout step and `id-token: write` only; `environment: npm` present
  - Synth test: `manifest.missing` empty; one Lambda asset; no Secrets Manager,
    no KMS key, no provisioned capacity in the template
- [x] 2. Research the unverified facts in `design.md` and amend it <!-- pattern: solo -->
- [x] 3. Repo scaffold: pnpm workspace, `packages/cdk` and `packages/cli`, oxlint, oxfmt, vitest, `ci.yml`, account-string check <!-- pattern: advisor -->
- [x] 4. `BatonBoard` and `BatonDistribution` constructs: table, GSIs, TTL, user pool, HTTP API with both authorizers, Lambda from `assets/api`, SPA from `assets/web` <!-- pattern: advisor -->
- [x] 5. Service: project, repo map, card, event and claim modules with the conditional writes and transactions <!-- pattern: advisor -->
- [x] 6. Service: auth, idempotency, error codes, listing states, dashboard counts <!-- pattern: advisor -->
- [x] 7. Web app: dashboard with register form, per-project board with drag, drawer, comments, repo filter and project settings, agents and tokens page <!-- pattern: advisor -->
- [x] 8. CLI package: `bin`, git detection, project resolution, `project register`, token resolution, JSON output <!-- pattern: advisor -->
- [x] 9. Build and pack: esbuild the Lambda and Vite the web app into `assets/`, `files` allowlists, pack test <!-- pattern: advisor -->
- [x] 10. `changelog.yml` and `release.yml` with staged npm publishing; owner sets up the `npm` environment and trusted publishing <!-- pattern: solo -->
  - The workflows and their lint tests are done. The owner's part (the `npm` environment, trusted publishing, the GitHub App
    secrets, the first-publish token, the `v0.*` tag) is not done: `docs/release-setup.md` lists the steps.
- [ ] 11. Skill in `claude-plugins`: `SKILL.md`, heartbeat and stop hooks calling the published CLI through `npx` at a pinned version <!-- pattern: advisor -->
- [ ] 12. Consumer: `apps/baton` in `andrewchemis.dev` on tributary's layout, config, pipeline, asset-path synth test <!-- pattern: advisor -->
- [ ] 13. Deploy through the `andrewchemis.dev` pipeline, seed the first agent token, run one real claim from a remote session <!-- pattern: solo -->
