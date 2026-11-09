import type { JSX } from 'preact';
import { ClaimedIcon, ReopenedIcon, StaleIcon, UnownedIcon, UnreadIcon } from './icons.tsx';
import type { CardView } from './types.ts';
import { ago, span, when } from './util.ts';

export type BadgeKind = 'claimed' | 'stale' | 'unowned' | 'reopened' | 'unread';

export function Badge(props: {
  kind: BadgeKind;
  children: JSX.Element | string | (JSX.Element | string)[];
  title?: string;
}) {
  const icon = {
    claimed: <ClaimedIcon />,
    stale: <StaleIcon />,
    unowned: <UnownedIcon />,
    reopened: <ReopenedIcon />,
    unread: <UnreadIcon />,
  }[props.kind];
  return (
    <span class={`badge ${props.kind}`} title={props.title} data-badge={props.kind}>
      {icon}
      <span class="badge-text">{props.children}</span>
    </span>
  );
}

/** Which badges a card shows. The state ones (claimed, stale, unowned) are exclusive; reopened and unread stack on top. */
export function badgesFor(card: CardView): BadgeKind[] {
  const kinds: BadgeKind[] = [];
  if (card.state === 'claimed' || card.state === 'stale' || card.state === 'unowned') kinds.push(card.state);
  if (card.reopened) kinds.push('reopened');
  if (card.unread) kinds.push('unread');
  return kinds;
}

export function CardBadges(props: { card: CardView; now: number }) {
  const { card, now } = props;
  const claim = card.claim;
  const where = claim ? `${claim.agentId} on ${claim.branch} in ${claim.worktree}` : undefined;
  return (
    <div class="badges">
      {card.state === 'claimed' && claim ? (
        <Badge kind="claimed" title={`Claimed: ${where}. Last heartbeat ${ago(claim.heartbeatAt, now)}.`}>
          {`${claim.agentId} · ${claim.branch}`}
        </Badge>
      ) : null}
      {card.state === 'stale' && claim ? (
        <Badge
          kind="stale"
          title={`Stale: ${where}. No heartbeat since ${when(claim.heartbeatAt)}; the lease ran out.`}
        >
          {`stale ${span(now - claim.heartbeatAt)} · ${claim.agentId}`}
        </Badge>
      ) : null}
      {card.state === 'unowned' ? (
        <Badge kind="unowned" title="In progress, but nobody holds it. Take it with an agent, or move it back.">
          unowned
        </Badge>
      ) : null}
      {card.reopened ? (
        <Badge
          kind="reopened"
          title="A person moved this back: the work was not accepted. The next agent to take it clears the flag."
        >
          reopened
        </Badge>
      ) : null}
      {card.unread ? (
        <Badge kind="unread" title="The last agent has not acknowledged the latest human comment, edit or move.">
          unread
        </Badge>
      ) : null}
    </div>
  );
}
