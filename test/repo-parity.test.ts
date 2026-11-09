// The CLI reads the repo from the origin URL and the service reads it from what the CLI sends, and they must name the same
// repository. They are separate implementations on purpose (the CLI ships alone and imports nothing from the service), so
// nothing but this test keeps them agreeing. The same goes for the key two project names share.
import { describe, expect, test } from 'vitest';
import { nameKey, normalizeRepo as cli } from '../packages/cli/src/git.ts';
import { REPO_URLS } from '../packages/cli/test/repo-urls.ts';
import { normalizeName, normalizeRepo as service } from '../packages/cdk/service/validate.ts';

describe('repo normalization', () => {
  test.each(REPO_URLS)('the CLI and the service both read %s as %s', (input, expected) => {
    expect(cli(input)).toBe(expected);
    expect(service(input)).toBe(expected);
  });
});

describe('project name key', () => {
  test.each(['My  Project', '  my project ', 'MY\u00a0PROJECT', 'a   b \u2003 c', 'plain', 'Ünïcode  Name'])(
    'the CLI and the service give %j one key',
    (name) => {
      expect(nameKey(name)).toBe(normalizeName(name).nameKey);
    },
  );
});
