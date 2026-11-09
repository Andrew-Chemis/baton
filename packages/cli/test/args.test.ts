import { describe, expect, test } from 'vitest';
import { flag, flagAll, has, parseArgs, UsageError } from '../src/args.ts';

describe('parseArgs', () => {
  test('separates positionals from flags, in either order', () => {
    const p = parseArgs(['take', '--to', 'ready', 'fix-login', '--no-move'], ['no-move']);
    expect(p.positional).toEqual(['take', 'fix-login']);
    expect(flag(p, 'to')).toBe('ready');
    expect(has(p, 'no-move')).toBe(true);
  });

  test('takes --name=value, repeats, and everything after --', () => {
    const p = parseArgs(['--link=https://a.test', '--link', 'https://b.test', '--', '--not-a-flag']);
    expect(flagAll(p, 'link')).toEqual(['https://a.test', 'https://b.test']);
    expect(p.positional).toEqual(['--not-a-flag']);
  });

  test('keeps an = inside the value', () => {
    expect(flag(parseArgs(['--body=a=b']), 'body')).toBe('a=b');
  });

  test('a flag that needs a value says so when it is last', () => {
    expect(() => parseArgs(['--title'])).toThrow(UsageError);
    expect(() => parseArgs(['--title'])).toThrow(/needs a value/);
  });

  test('the last of a repeated flag wins for flag()', () => {
    expect(flag(parseArgs(['--to', 'a', '--to', 'b']), 'to')).toBe('b');
  });
});
