import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { scan } from '../scripts/check-strings.ts';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'baton-strings-'));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('account-string check', () => {
  test('fails on a planted account id in a package source file', () => {
    const root = tree({ 'packages/cdk/src/a.ts': "export const account = '123456789012';\n" });
    const found = scan(root);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'packages/cdk/src/a.ts', line: 1, rule: '12-digit account-shaped number' });
  });

  test('fails on an ARN and on the owner domain, in packages and in .github', () => {
    const root = tree({
      'packages/cli/src/b.ts': "const role = 'arn:aws:iam::role/x';\n",
      '.github/workflows/w.yml': 'url: https://andrewchemis.dev/x\n',
    });
    const rules = scan(root).map((v) => v.rule);
    expect(rules.toSorted()).toEqual(['ARN', "owner's domain"]);
  });

  test('does not flag longer or shorter digit runs', () => {
    const root = tree({ 'packages/cdk/src/c.ts': 'const ms = 1700000000000; const small = 12345678901;\n' });
    expect(scan(root)).toEqual([]);
  });

  test('ignores tests, build output and node_modules', () => {
    const root = tree({
      'packages/cdk/test/a.test.ts': "const id = '123456789012';\n",
      'packages/cdk/assets/api/index.js': 'arn:aws:x\n',
      'packages/cdk/node_modules/x/index.js': '123456789012\n',
      'packages/cdk/lib/index.js': '123456789012\n',
    });
    expect(scan(root)).toEqual([]);
  });

  test('exempts the spec, the README and docs', () => {
    const root = tree({
      'README.md': 'andrewchemis.dev\n',
      '.kiro/specs/baton-board/design.md': 'andrewchemis.dev\n',
      'docs/release-setup.md': '123456789012\n',
    });
    expect(scan(root)).toEqual([]);
  });

  test('the repository itself is clean', () => {
    expect(scan(join(import.meta.dirname, '..'))).toEqual([]);
  });
});
