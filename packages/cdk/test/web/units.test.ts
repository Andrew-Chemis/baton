import { describe, expect, test } from 'vitest';
import { positionAt, slotAt } from '../../web/src/dnd.ts';
import { ago, span } from '../../web/src/util.ts';

describe('ago and span', () => {
  const now = 1_000_000_000;
  test.each([
    [0, 'just now'],
    [44, 'just now'],
    [60, '1m ago'],
    [59 * 60, '59m ago'],
    [3 * 3600, '3h ago'],
    [47 * 3600, '47h ago'],
    [3 * 86400, '3d ago'],
  ])('%is back reads %s', (seconds, text) => {
    expect(ago(now - seconds * 1000, now)).toBe(text);
  });
  test('span drops the "ago"', () => {
    expect(span(40 * 60_000)).toBe('40m');
    expect(span(5_000)).toBe('<1m');
  });
});

describe('drag slots', () => {
  test('the slot is the first card whose midpoint the pointer is above', () => {
    expect(slotAt([100, 200, 300], 50)).toBe(0);
    expect(slotAt([100, 200, 300], 150)).toBe(1);
    expect(slotAt([100, 200, 300], 250)).toBe(2);
    expect(slotAt([100, 200, 300], 999)).toBe(3);
    expect(slotAt([], 10)).toBe(0);
  });

  test('a position put at any slot sorts exactly there', () => {
    const column = [{ pos: 'a' }, { pos: 'b' }, { pos: 'c' }, { pos: 'cz' }];
    for (let index = 0; index <= column.length; index += 1) {
      const pos = positionAt(column, index) as string;
      const placed = [...column.slice(0, index), { pos }, ...column.slice(index)];
      expect(placed.map((c) => c.pos)).toEqual(placed.map((c) => c.pos).toSorted());
      expect(new Set(placed.map((c) => c.pos)).size).toBe(placed.length);
    }
  });

  test('equal neighbours (a race) yield no position, so the board appends', () => {
    expect(positionAt([{ pos: 'n' }, { pos: 'n' }], 1)).toBeUndefined();
  });
});
