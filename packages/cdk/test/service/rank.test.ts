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

  test('2,000 appends stay valid and strictly increasing, and any adjacent pair can still be split', () => {
    const list = [between(null, null)];
    for (let i = 1; i < 2000; i += 1) list.push(between(list.at(-1) ?? null, null));
    for (const [i, pos] of list.entries()) {
      expect(isPos(pos), `append ${i}: ${pos}`).toBe(true);
      if (i > 0) expect((list[i - 1] ?? '') < pos).toBe(true);
    }
    // The old rule halved the remaining range and gained a character about every six appends: 321 appends reached 65.
    expect(Math.max(...list.map((p) => p.length))).toBeLessThan(64);
    for (let i = 0; i + 1 < list.length; i += 1) {
      const mid = between(list[i] ?? null, list[i + 1] ?? null);
      expect(isPos(mid)).toBe(true);
      expect((list[i] ?? '') < mid && mid < (list[i + 1] ?? '')).toBe(true);
    }
  });

  test('a position of up to 255 characters is valid, and 256 is not', () => {
    expect(isPos('1'.repeat(255))).toBe(true);
    expect(isPos('1'.repeat(256))).toBe(false);
    expect(isPos('10')).toBe(false);
  });

  test('rejects positions that are not in order', () => {
    expect(() => between('b', 'a')).toThrow();
  });
});
