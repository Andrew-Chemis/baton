// Writes one version into everything that carries it: both packages, and the pin in the reference copies of the skill and its
// hooks, which name the CLI version they were written for. semantic-release runs it as its prepare step, so the tag, the
// changelog and these files agree.
//   node scripts/set-version.ts 0.2.1
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGES, root as REPO_ROOT } from './pack.ts';

/** Repo-relative paths of the package manifests, each with exactly one `"version"` key. */
export const MANIFESTS = PACKAGES.map((name) => `packages/${name}/package.json`);

/** Files that pin the CLI as `@andrewchemis/baton-cli@x.y.z`. */
export const PINNED = [
  'packages/cli/skill/baton/SKILL.md',
  'packages/cli/skill/baton/hooks/heartbeat.sh',
  'packages/cli/skill/baton/hooks/stop.sh',
];

export const VERSION_FILES = [...MANIFESTS, ...PINNED];

const SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_KEY = /("version":\s*")[^"]+(")/g;
const PIN = /(@andrewchemis\/baton-cli@)\d+\.\d+\.\d+/g;
const HAS_PIN = /@andrewchemis\/baton-cli@\d+\.\d+\.\d+/;

/** Rewrites the version in each file, keeping its formatting; returns the paths it wrote. */
export function setVersion(root: string, version: string): string[] {
  if (!SEMVER.test(version)) throw new Error(`not a plain x.y.z version: ${version}`);
  if (!version.startsWith('0.')) {
    throw new Error(`refusing ${version}: both packages stay on 0.x until the owner says otherwise`);
  }
  return VERSION_FILES.map((path) => {
    const file = join(root, path);
    const text = readFileSync(file, 'utf8');
    if (MANIFESTS.includes(path)) {
      if ((text.match(VERSION_KEY) ?? []).length !== 1) throw new Error(`${path} must hold exactly one "version" key`);
      writeFileSync(file, text.replace(VERSION_KEY, `$1${version}$2`));
    } else {
      if (!HAS_PIN.test(text)) throw new Error(`${path} must pin @andrewchemis/baton-cli`);
      writeFileSync(file, text.replace(PIN, `$1${version}`));
    }
    return path;
  });
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) throw new Error('usage: node scripts/set-version.ts <version>');
  for (const path of setVersion(REPO_ROOT, version)) console.log(`set ${version} in ${path}`);
}
