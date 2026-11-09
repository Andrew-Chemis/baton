// The release pipeline is code that publishes to a public registry, so its rules are checked like code. Every action is pinned to
// a full commit SHA that is one of the pins already in use in the owner's other repositories; the publish job runs no repository
// code and holds the only OIDC token; the release rules cannot produce a major version.
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { root } from '../scripts/pack.ts';
import { VERSION_FILES } from '../scripts/set-version.ts';

const dir = join(root, '.github', 'workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
const text = (name: string) => readFileSync(join(dir, name), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = (name: string) => parse(text(name)) as Workflow;

// Copied from the workflows of the owner's other public repository. A new action or a new version is a deliberate edit here.
const PINS: Record<string, { sha: string; version: string }> = {
  'actions/checkout': { sha: '3d3c42e5aac5ba805825da76410c181273ba90b1', version: 'v7.0.1' },
  'actions/create-github-app-token': { sha: '64ab729a6294000f5aa4a4bc0b73d1f32bc45510', version: 'v3' },
  'actions/download-artifact': { sha: '9000827ccba6bdab643e8b6fd33ac0654aef8333', version: 'v8.0.2' },
  'actions/setup-node': { sha: '949feb2413d6458794dcd2491c4babbbce0c15c1', version: 'v7.1.0' },
  'actions/upload-artifact': { sha: 'cf430e030ddbb5b0abf93d22962f4752f3646cd9', version: 'v7.0.2' },
  'pnpm/action-setup': { sha: 'ea17c68df8912ef543352723c149a84f56e3d413', version: 'v6.1.0' },
};

describe('every workflow', () => {
  test('there are the three expected', () => {
    expect(files.toSorted()).toEqual(['changelog.yml', 'ci.yml', 'release.yml']);
  });

  test.each(files)('%s: permissions are empty at the top and granted per job', (name) => {
    const wf = workflow(name);
    expect(wf.permissions).toEqual({});
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(job.permissions, `${name} ${id}`).toBeTruthy();
    }
  });

  test.each(files)('%s: every `uses:` is a full SHA from the table, with its version in a trailing comment', (name) => {
    const lines = text(name)
      .split('\n')
      .filter((l) => /^\s*(-\s+)?uses:/.test(l));
    const parsedCount = Object.values(workflow(name).jobs).reduce(
      (n, job) => n + job.steps.filter((s) => s.uses).length,
      0,
    );
    expect(lines.length).toBe(parsedCount);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const match = /uses:\s*([\w./-]+)@([0-9a-f]{40})\s+#\s*(v[\w.]+)\s*$/.exec(line);
      expect(match, line).not.toBeNull();
      const [, action, sha, version] = match as RegExpExecArray;
      expect(PINS[action as string], `${action} is not in the table of known pins`).toEqual({ sha, version });
    }
  });

  test.each(files)('%s: no step takes a local or docker action, and no ref is a branch or tag', (name) => {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  test.each(files)('%s: a checkout keeps no credentials in the work tree', (name) => {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  test.each(files)('%s: pnpm is the version the repository pins', (name) => {
    const pinned = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager: string })
      .packageManager;
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith('pnpm/action-setup@'))) {
        expect(`pnpm@${String(step.with?.version)}`).toBe(pinned);
      }
    }
  });

  test.each(files)('%s: the node version satisfies the repository engines field', (name) => {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/setup-node@'))) {
        expect(Number.parseFloat(String(step.with?.['node-version']))).toBeGreaterThanOrEqual(22.18);
      }
    }
  });

  test('no workflow carries a literal secret, token or key', () => {
    for (const name of files) {
      const body = text(name);
      expect(body).not.toMatch(/ghp_|github_pat_|npm_[A-Za-z0-9]{20,}|-----BEGIN/);
    }
  });
});

describe('release.yml', () => {
  const wf = workflow('release.yml');
  const publish = wf.jobs.publish as Job;
  const build = wf.jobs.build as Job;

  test('starts from a published release, or by hand, and never on a push', () => {
    expect(Object.keys(wf.on).toSorted()).toEqual(['release', 'workflow_dispatch']);
  });

  test('the publish job has no checkout, installs no repository code, and holds id-token: write alone', () => {
    expect(publish.steps.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(publish.permissions).toEqual({ 'id-token': 'write' });
    const commands = publish.steps.map((s) => s.run ?? '').join('\n');
    expect(commands).not.toMatch(/pnpm|yarn|npm (ci|install)(?! --global npm@)|git |scripts\//);
    expect(publish.environment).toBe('npm');
    expect(publish.needs).toBe('build');
  });

  test('the publish job uploads the artifact the build job made, and nothing from the checkout', () => {
    const download = publish.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    const upload = build.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(download?.with?.name).toBe('tarballs');
    expect(upload?.with?.name).toBe('tarballs');
    const stage = publish.steps.find((s) => s.name === 'Stage');
    expect(stage?.run).toContain('npm stage publish');
    expect(stage?.run).toContain('--provenance');
    expect(stage?.run).toContain('--access public');
  });

  test('only the publish job sees the npm token, and only the build job runs repository code', () => {
    expect(JSON.stringify(build)).not.toContain('NPM_TOKEN');
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(build.environment).toBeUndefined();
  });

  test('both jobs are skipped in a private repository', () => {
    expect(build.if).toContain('!github.event.repository.private');
    expect(publish.if).toContain('!github.event.repository.private');
  });

  test('the build job runs the same checks as ci, and the pack test', () => {
    const commands = build.steps.map((s) => s.run ?? '');
    for (const wanted of ['pnpm typecheck', 'pnpm lint', 'pnpm check:strings', 'pnpm test', 'pnpm test:pack']) {
      expect(commands, wanted).toContain(wanted);
    }
  });

  test('the packed list is a tab-separated file the publish job reads', () => {
    const pack = build.steps.find((s) => s.name === 'Pack');
    expect(pack?.run).toContain('node scripts/pack.ts');
    expect(pack?.run).toContain('packed.tsv');
  });
});

describe('changelog.yml', () => {
  const wf = workflow('changelog.yml');
  const job = wf.jobs.release as Job;

  test('runs on a push to main and by hand, in a public repository, and requires a 0.x baseline tag', () => {
    expect(Object.keys(wf.on).toSorted()).toEqual(['push', 'workflow_dispatch']);
    expect(job.if).toContain('!github.event.repository.private');
    expect(job.steps.some((s) => s.run?.includes("--list 'v0.*'"))).toBe(true);
  });

  test('releases with an app token, not the workflow token, and publishes nothing to a registry', () => {
    const release = job.steps.find((s) => s.run?.trim() === 'pnpm exec semantic-release');
    expect(release?.env?.GITHUB_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(text('changelog.yml')).not.toMatch(/npm (publish|stage)/);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).not.toHaveProperty('id-token');
  });
});

describe('ci.yml', () => {
  const job = workflow('ci.yml').jobs.test as Job;

  test('has no credentials and no OIDC: it holds read access to the code and nothing else', () => {
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(text('ci.yml')).not.toMatch(/secrets\./);
  });

  test('runs every check the repository states', () => {
    const commands = job.steps.map((s) => s.run ?? '');
    for (const wanted of [
      'pnpm typecheck',
      'pnpm lint',
      'pnpm format:check',
      'pnpm check:strings',
      'pnpm test',
      'pnpm test:pack',
    ]) {
      expect(commands, wanted).toContain(wanted);
    }
  });

  test('validates commit messages on a pull request', () => {
    const step = job.steps.find((s) => s.run?.includes('commitlint'));
    expect(step?.if).toContain('pull_request');
  });
});

describe('.releaserc.json', () => {
  const config = JSON.parse(readFileSync(join(root, '.releaserc.json'), 'utf8')) as {
    branches: string[];
    tagFormat: string;
    plugins: (string | [string, Record<string, any>])[];
  };
  const named = (name: string) => {
    const hit = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
    return Array.isArray(hit) ? hit[1] : {};
  };

  test('releases from main with v-prefixed tags', () => {
    expect(config.branches).toEqual(['main']);
    expect(config.tagFormat).toBe('v${version}');
  });

  test('writes the version with the script the tests cover, before the commit that carries it', () => {
    const order = config.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(order.indexOf('@semantic-release/exec')).toBeLessThan(order.indexOf('@semantic-release/git'));
    expect(order.indexOf('@semantic-release/changelog')).toBeLessThan(order.indexOf('@semantic-release/git'));
    expect(named('@semantic-release/exec').prepareCmd).toBe('node scripts/set-version.ts ${nextRelease.version}');
  });

  test('commits every file set-version rewrites, plus the changelog, and nothing else', () => {
    const assets = named('@semantic-release/git').assets as string[];
    const covered = (path: string) =>
      assets.some((a) => a === path || (a.includes('*') && new RegExp(`^${a.replaceAll('*', '[^/]+')}$`).test(path)));
    for (const path of VERSION_FILES) expect(covered(path), path).toBe(true);
    expect(assets).toContain('CHANGELOG.md');
    expect(assets.filter((a) => !VERSION_FILES.includes(a) && a !== 'CHANGELOG.md' && !a.includes('*'))).toEqual([]);
  });

  test('every plugin it names is installed', () => {
    const require = createRequire(join(root, 'package.json'));
    for (const plugin of config.plugins) {
      const name = Array.isArray(plugin) ? plugin[0] : plugin;
      expect(() => require.resolve(name), name).not.toThrow();
    }
  });

  test('there is no npm plugin: publishing is the release workflow, staged and approved', () => {
    expect(JSON.stringify(config.plugins)).not.toContain('@semantic-release/npm');
  });

  describe('which commits release what', () => {
    const analyzer = (named('semantic-release-unsquash') as { commitAnalyzerConfig: Record<string, unknown> })
      .commitAnalyzerConfig;
    const logger = { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    const release = (message: string) =>
      analyzeCommits(analyzer, { commits: [{ hash: 'a'.repeat(40), message }], logger, cwd: root });

    test.each([
      ['feat: a thing', 'patch'],
      ['fix(web): a thing', 'patch'],
      ['test: a thing', 'patch'],
      ['build: a thing', 'patch'],
      ['ci: a thing', 'patch'],
      ['docs: a thing', 'patch'],
      ['chore: a thing', 'patch'],
      ['chore(minor): the owner asks for a minor', 'minor'],
    ])('%s releases a %s', async (message, expected) => {
      expect(await release(message)).toBe(expected);
    });

    test.each([
      'feat!: remove a verb',
      'fix(cli)!: change an exit code',
      'feat: a thing\n\nBREAKING CHANGE: it no longer works the old way',
      'feat: a thing\n\nBREAKING-CHANGE: it no longer works the old way',
    ])('a breaking marker is capped at a minor: %j', async (message) => {
      expect(await release(message)).toBe('minor');
    });

    test('a commit that is not conventional releases nothing', async () => {
      expect(await release('Update stuff')).toBeNull();
    });
  });
});
