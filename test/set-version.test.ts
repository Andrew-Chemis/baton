// The release writes one version into both packages and into the pin the reference skill and hooks carry. A wrong or partial
// write ships a skill that names a CLI the package it sits in is not, so the script is held to rewriting exactly those places.
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { root } from '../scripts/pack.ts';
import { MANIFESTS, PINNED, VERSION_FILES, setVersion } from '../scripts/set-version.ts';

function copyOfTheFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baton-version-'));
  for (const path of VERSION_FILES) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(root, path), join(dir, path));
  }
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

describe('setVersion', () => {
  test('writes the version into both manifests and every pin, and touches nothing else', () => {
    const dir = copyOfTheFiles();
    const before = Object.fromEntries(VERSION_FILES.map((p) => [p, read(dir, p)]));
    expect(setVersion(dir, '0.7.3')).toEqual(VERSION_FILES);
    for (const path of MANIFESTS) {
      const manifest = JSON.parse(read(dir, path)) as { version: string };
      expect(manifest.version).toBe('0.7.3');
      // Only the version line differs.
      expect(read(dir, path).replace('0.7.3', '@')).toBe(
        (before[path] as string).replace(/"version": "[^"]+"/, '"version": "@"'),
      );
    }
    for (const path of PINNED) {
      const text = read(dir, path);
      expect(text).toContain('@andrewchemis/baton-cli@0.7.3');
      expect(text.match(/@andrewchemis\/baton-cli@\d+\.\d+\.\d+/g)?.every((m) => m.endsWith('@0.7.3'))).toBe(true);
      expect(text.replaceAll('0.7.3', '@')).toBe((before[path] as string).replace(/(baton-cli@)\d+\.\d+\.\d+/g, '$1@'));
    }
  });

  test('a second run with the same version changes nothing', () => {
    const dir = copyOfTheFiles();
    setVersion(dir, '0.3.0');
    const once = VERSION_FILES.map((p) => read(dir, p));
    setVersion(dir, '0.3.0');
    expect(VERSION_FILES.map((p) => read(dir, p))).toEqual(once);
  });

  test.each(['1.0.0', '2.3.4'])('refuses %s: the packages stay on 0.x', (version) => {
    expect(() => setVersion(copyOfTheFiles(), version)).toThrow(/0\.x/);
  });

  test.each(['0.1', 'v0.1.2', '0.1.2-beta.1', ''])('refuses %j: only a plain x.y.z', (version) => {
    expect(() => setVersion(copyOfTheFiles(), version)).toThrow(/plain x\.y\.z/);
  });

  test('the two packages and the pins start out in step', () => {
    const versions = MANIFESTS.map(
      (p) => (JSON.parse(readFileSync(join(root, p), 'utf8')) as { version: string }).version,
    );
    expect(new Set(versions).size).toBe(1);
    for (const path of PINNED) {
      expect(readFileSync(join(root, path), 'utf8')).toContain(`@andrewchemis/baton-cli@${versions[0]}`);
    }
  });
});
