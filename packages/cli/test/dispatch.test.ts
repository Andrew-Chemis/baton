// The command word is typed by a person or a model. Only the commands the table names run: a name that exists on every
// object (`constructor`, `toString`, `__proto__`) is not a command, and nothing is printed that was not asked for.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startWorld, type World } from './harness.ts';

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => w.close());

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

describe('the command table', () => {
  test.each(INHERITED)('"%s" is an unknown command, and no token is printed', async (word) => {
    const result = await w.baton([word], { cwd: w.repo() });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.error.code).toBe('usage');
    expect(result.error.message).toContain(`Unknown command "${word}".`);
    expect(result.stdout + result.stderr).not.toContain(w.token);
  });

  test.each(['project', 'hook'])('"%s" with an inherited name is a usage error, not a call', async (verb) => {
    for (const word of INHERITED) {
      const result = await w.baton([verb, word], { cwd: w.repo() });
      expect(result.code, `${verb} ${word}`).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.error.code).toBe('usage');
      expect(result.stdout + result.stderr).not.toContain(w.token);
    }
  });
});
