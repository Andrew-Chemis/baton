# Release setup

What the owner does once, by hand, before the first release. The workflows cannot do these steps, and none of them
belongs in the repository.

How a release goes, after the setup:

1. A commit lands on `main`. `changelog.yml` computes the next version from the Conventional Commits since the last tag
   (every type is a patch; a minor only from a `chore(minor):` commit; a breaking marker is capped at a minor), writes
   `CHANGELOG.md`, writes the version into both packages and the pin in the reference skill and hooks, commits that,
   tags it and publishes a GitHub release.
2. The published release starts `release.yml`. Its `build` job checks that the tag is on `main` and names the version in
   the packages, installs, typechecks, lints, runs the account-string check and the tests, runs the pack test, packs
   both tarballs and writes their file lists and hashes to the run summary.
3. The `publish` job waits for you to approve the `npm` environment. It has no checkout and installs nothing from the
   repository. It stages the tarballs with `npm stage publish` and provenance. Nothing is public yet.
4. You approve each staged version on npmjs.com (Staged Packages tab) or with `npm stage approve <stage-id>`, with 2FA.

## 1. The repository

- Public. Both workflows skip every job in a private repository, and npm provenance needs a public one.
- `repository.url` in both `package.json` files is `git+https://github.com/Andrew-Chemis/baton.git`. npm checks it against
  the repository the workflow runs in, and its documentation says it must match exactly, so if the repository is ever
  renamed or its owner's capitalisation differs from this, change the field.

## 2. A baseline tag

`changelog.yml` refuses to run until a `v0.*` tag is reachable from `main`. Without one, semantic-release would start at
1.0.0, and both packages stay on 0.x (`scripts/set-version.ts` refuses anything else). After the first commit lands on `main`:

```sh
git tag v0.1.0 <that commit>
git push origin v0.1.0
```

The first release is then 0.1.1.

## 3. A GitHub App for the release commit

The release commit goes straight to `main`, and if `main` has a ruleset that requires pull requests, the committer needs
to be its bypass actor. The workflow token cannot be one, and a release published with the workflow token would not start
`release.yml` either. So:

1. Create a GitHub App (Settings, Developer settings, GitHub Apps). Repository permissions: Contents, Issues and Pull
   requests, each Read and write. No webhook is needed.
2. Install it on this repository only.
3. Add it as a bypass actor on the ruleset for `main`.
4. Generate a private key. Add two repository secrets: `SEMANTIC_RELEASE_APP_ID` (the app's id) and
   `SEMANTIC_RELEASE_PRIVATE_KEY` (the whole PEM).

## 4. The `npm` environment

Settings, Environments, New environment, named `npm` exactly (`release.yml` names it, and so will the trusted
publisher).

- Required reviewers: you. This is the approval step between a build and the registry.
- Deployment branches and tags: choose "Selected branches and tags" and add one rule, a tag rule matching `v*`, and no
  branch rule. This is required: a release event runs on the release's tag, and a manual run from a branch is then
  refused before the publish job can start. Leaving the environment open to all refs would let any branch be staged
  once the reviewer approves it.
- Environment secrets: none, except for the first publish (next section).

## 5. The first publish

The `@andrewchemis` scope has to be yours on npm: your user name, or an organization you own. The two packages are
`@andrewchemis/baton-cdk` and `@andrewchemis/baton-cli`.

npm's trusted-publisher setting lives in a package's settings on npmjs.com, which implies the package exists first;
npm's documentation does not describe configuring one beforehand. The Lede repository's pipeline, which this one is
modelled on, used a token for its first publish, so do the same:

1. On npmjs.com create a granular access token that can write packages in the `@andrewchemis` scope, with the shortest
   expiry that covers the first release.
2. Add it as an environment secret named `NPM_TOKEN` on the `npm` environment (an environment secret, not a repository
   secret: only the publish job runs in that environment).
3. Cut the first release and approve the environment and the staged versions as above.

**Placeholder risk.** The Lede pipeline's notes say that staging a package that does not exist yet makes npm publish a
public placeholder, version `0.0.0-stage`. That was not checked here, because staging cannot be exercised without
publishing. If it happens, the placeholder is harmless and the real version is staged next to it, but it is public. If
you would rather avoid it, publish the first version of each package by hand instead and skip to step 6.

## 6. Trusted publishing, then delete the token

After the first version of each package exists, on npmjs.com open the package's Settings, Trusted publisher, and enter:

- Provider: GitHub Actions
- Organization or user: `Andrew-Chemis`
- Repository: `baton`
- Workflow filename: `release.yml`
- Environment name: `npm`

Do this for both packages. npm's documentation says a newly created trusted-publisher configuration must complete its first
successful publish within 2 days, so cut a release soon after. Then delete the `NPM_TOKEN` environment secret and revoke
the token on npm: with no token set, `npm stage publish` authenticates through the workflow's OIDC token.

Trusted publishing needs npm 11.5.1 or later; `npm stage` needs 11.15.0 or later. Node 24 does not bundle that, so the
publish job installs a pinned npm (`release.yml`, "Install npm"). A test fails if that job gains a checkout, any repository
code, or any permission besides `id-token: write`.

## 7. Approving a staged version

For each package, with 2FA:

```sh
npm stage list @andrewchemis/baton-cdk
npm stage approve <stage-id>
```

or use the Staged Packages tab on npmjs.com. The run summary of the publish job lists the stage ids.

If a run fails halfway, rerun it: a version already on npm is skipped. A version already staged is not detected, so reject
the older stage first with `npm stage reject <stage-id>`.

## What was not exercised

None of the above ran. The workflows were checked by a test that parses them (every `uses:` pinned to a full SHA, the
publish job's permissions and steps, the release rules against the commit analyzer) and by running the pack test, which
builds, packs and installs the tarballs exactly as the `build` job does. Nothing was run on GitHub's runners, against npm's
staging, or against a GitHub App.
