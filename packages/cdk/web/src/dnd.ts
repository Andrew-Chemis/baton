// The pure part of dragging a card: which slot the pointer is over, and the position string that puts the card there.
import { between } from '../../service/rank.ts';

/** Index among the cards of a column (the dragged one excluded) that a pointer at `y` is above; the count means the end. */
export function slotAt(midpoints: number[], y: number): number {
  const index = midpoints.findIndex((mid) => y < mid);
  return index === -1 ? midpoints.length : index;
}

/** The position that puts a card at `index` among `others`, which are in column order and do not include the card. */
export function positionAt(others: { pos: string }[], index: number): string | undefined {
  const before = index > 0 ? (others[index - 1]?.pos ?? null) : null;
  const after = others[index]?.pos ?? null;
  try {
    return between(before, after);
  } catch {
    // Neighbours with equal positions (two moves that raced): let the board put it at the end.
    return undefined;
  }
}
