# Contributing

Thanks for helping. Bug reports and pull requests are welcome; for a larger change, open an issue first so we can agree on
the shape before you build it.

## Set up

Node 22.18 or later, pnpm (the version in `package.json`'s `packageManager`), and Java 17 or later for DynamoDB Local, which
the tests download (pinned, checked against its SHA-256) and start on their own.

```sh
pnpm install
pnpm --filter @andrewchemis/baton-cdk run build:assets   # the Lambda bundle and the web app
pnpm dev --seed                                         # the board on http://127.0.0.1:5173 with a demo of every state
```

## Checks

CI runs all of these on every pull request; run them before you push.

```sh
pnpm typecheck
pnpm lint            # oxlint, type-aware; a warning fails it
pnpm format:check    # oxfmt; `pnpm format` fixes
pnpm check:strings   # nothing account-specific in packages/ or .github/
pnpm test            # service, CLI, web, CDK synth, workflow and contract tests
pnpm test:e2e        # the web app in Chromium (needs Playwright's Chromium: pnpm exec playwright-core install chromium)
pnpm test:pack       # builds and installs the packed tarballs (needs the npm registry)
```

Run one file with `pnpm exec vitest run <path>`.

## Where things live

| Path                         | What                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `packages/cdk/service/`      | The API: router, cards, claims, projects, agents, migrations, telemetry  |
| `packages/cdk/src/`          | The CDK constructs                                                       |
| `packages/cdk/web/`          | The web app (Preact, Vite)                                               |
| `packages/cli/`              | The `baton` command and the reference skill and hooks                    |
| `docs/openapi.yaml`          | The API contract                                                         |
| `docs/architecture.md`       | How it fits together                                                     |
| `.kiro/specs/baton-board/`   | The requirements and design the code is held to                         |

## Rules of the road

- **Conventional Commits**, with body lines at most 100 columns; commitlint checks every pull request. Sign off your commits
  (`git commit -s`). Never mark a commit breaking (`!` or `BREAKING CHANGE:`): the packages stay on 0.x and a consumer-visible
  change is described in the body in plain words.
- **A change to the API changes `docs/openapi.yaml` in the same commit.** The contract test fails otherwise: a new route, a
  new error code, or a new field on a response all need documenting.
- **A change to how stored items are shaped needs a migration.** Append one to `MIGRATIONS` in
  `packages/cdk/service/migrations.ts`, raise `LATEST_SCHEMA` in `packages/cdk/src/schema-version.ts`, and test it against
  items in the old shape. Never edit a released migration. A migration must be idempotent, and must write an item only under
  a condition that it has not changed since it was read.
- **Anything with a standing monthly charge is opt-in**, and the synth test's cost-policy check says so.
- **Logs never hold bodies, headers, tokens or emails.**
- **Every error message says what to do next.** Agents read them.
- **Pin GitHub Actions to a commit SHA** and add it to the table in `test/workflows.test.ts`.

## Releasing

Maintainers only: `changelog.yml` cuts a version from the commits on `main`, and `release.yml` stages it on npm for the
owner's approval. See [docs/release-setup.md](docs/release-setup.md).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
