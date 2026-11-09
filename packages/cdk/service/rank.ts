// Fractional position strings for drag ordering: between() returns a string that sorts strictly between two others, so
// moving a card rewrites that card alone. Base-36 digits; the algorithm is the usual midpoint on digit strings.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0] as string;

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || b?.endsWith(ZERO)) throw new Error('trailing zero');
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0] as string) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
  // Appending steps the digit up by one, so a long column grows a character about every 35 cards, not every 6.
  if (b === null && a !== '' && digitA + 1 < DIGITS.length) return DIGITS[digitA + 1] as string;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))] as string;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  const rest = a.slice(1);
  // A new character at the end of a column starts one step above zero, so it has the whole range to climb.
  return (DIGITS[digitA] as string) + (b === null && rest === '' ? (DIGITS[1] as string) : midpoint(rest, null));
}

export const isPos = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-z]{1,255}$/.test(value) && !value.endsWith(ZERO);

/** A position strictly after `after` and strictly before `before`; null means the start or the end of the column. */
export function between(after: string | null, before: string | null): string {
  return midpoint(after ?? '', before);
}

/** Order within a column: by position, then by id when two cards ended up with one position. The board and the API agree on it. */
export const comparePos = (a: { pos: string; id: string }, b: { pos: string; id: string }): number =>
  a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1;
