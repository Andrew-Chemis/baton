// The CLI reads the repo from the origin URL and the service reads it from what the CLI sends, and they must name the same
// repository. They are separate implementations on purpose (the CLI ships alone and imports nothing from the service), so
// nothing but this test keeps them agreeing.
import { describe, expect, test } from 'vitest';
import { normalizeRepo as cli } from '../packages/cli/src/git.ts';
import { REPO_URLS } from '../packages/cli/test/repo-urls.ts';
import { normalizeRepo as service } from '../packages/cdk/service/validate.ts';

describe('repo normalization', () => {
  test.each(REPO_URLS)('the CLI and the service both read %s as %s', (input, expected) => {
    expect(cli(input)).toBe(expected);
    expect(service(input)).toBe(expected);
  });
});
