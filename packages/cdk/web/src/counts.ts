// The five counts the dashboard and the board header show, and how the board works them out from the cards it loaded.
import type { BadgeKind } from './badges.tsx';
import type { CardView } from './types.ts';

export const COUNT_KINDS: readonly BadgeKind[] = ['claimed', 'stale', 'unowned', 'reopened', 'unread'];

/**
 * The same five counts the board API folds per project (`foldCounts` in the service), from a project's cards as listed:
 * archived cards do not count, and neither the repo filter nor the archived toggle may change the answer, so call this
 * with everything the list returned. A test holds the two to each other.
 */
export function tally(cards: CardView[]): Record<BadgeKind, number> {
  const counts: Record<BadgeKind, number> = { claimed: 0, stale: 0, unowned: 0, reopened: 0, unread: 0 };
  for (const card of cards) {
    if (card.archived) continue;
    if (card.state === 'claimed' || card.state === 'stale' || card.state === 'unowned') counts[card.state] += 1;
    if (card.reopened) counts.reopened += 1;
    if (card.unread) counts.unread += 1;
  }
  return counts;
}
