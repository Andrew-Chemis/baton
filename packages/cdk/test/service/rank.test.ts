import { describe, expect, test } from 'vitest';
import { between, isPos } from '../../service/rank.ts';

describe('between', () => {
  test('starts a column and appends after the last', () => {
    const first = between(null, null);
    const second = between(first, null);
    expect(first < second).toBe(true);
    expect(isPos(first) && isPos(second)).toBe(true);
  });

  test('always lands strictly between its neighbours, however often one slot is split', () => {
    let lo = between(null, null);
    const hi = between(lo, null);
    for (let i = 0; i < 200; i += 1) {
      const mid = between(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      expect(isPos(mid)).toBe(true);
      lo = mid;
    }
  });

  test('keeps the order of random inserts', () => {
    const list: string[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i += 1) {
      const at = Math.floor(rnd() * (list.length + 1));
      const pos = between(list[at - 1] ?? null, list[at] ?? null);
      list.splice(at, 0, pos);
    }
    expect(list.toSorted()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });

  test('rejects positions that are not in order', () => {
    expect(() => between('b', 'a')).toThrow();
  });
});
