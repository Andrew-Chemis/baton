import { CardBadges } from './badges.tsx';
import { GripIcon } from './icons.tsx';
import type { CardView } from './types.ts';

const repoName = (repo: string): string => repo.split('/').at(-1) ?? repo;
const slugOf = (card: CardView): string | null => (card.key ? (card.key.split('/').at(-1) ?? null) : null);

export type TilePointerEvent = PointerEvent & { currentTarget: HTMLElement };

export interface TileProps {
  card: CardView;
  now: number;
  showRepo: boolean;
  dragging?: boolean;
  ghost?: boolean;
  onOpen?: () => void;
  onPointerDown?: (event: TilePointerEvent) => void;
  onPointerMove?: (event: TilePointerEvent) => void;
  onPointerUp?: (event: TilePointerEvent) => void;
  onPointerCancel?: (event: TilePointerEvent) => void;
}

export function CardTile(props: TileProps) {
  const { card } = props;
  const slug = slugOf(card);
  const label = [
    card.title,
    card.state === 'unclaimed' ? '' : card.state,
    card.reopened ? 'reopened' : '',
    card.unread ? 'unread' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div
      class={`card${props.dragging ? ' dragging' : ''}${props.ghost ? ' ghost' : ''}`}
      data-card-id={card.id}
      data-state={card.state}
      data-reopened={card.reopened ? 'true' : undefined}
      data-unread={card.unread ? 'true' : undefined}
      role={props.ghost ? undefined : 'button'}
      tabIndex={props.ghost ? -1 : 0}
      aria-label={props.ghost ? undefined : label}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onOpen?.();
        }
      }}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <span class="bar" aria-hidden="true" />
      <span class="grip" aria-hidden="true">
        <GripIcon />
      </span>
      <div class="card-title">{card.title}</div>
      {props.showRepo || slug ? (
        <div class="card-meta">
          {props.showRepo ? <span class="repo">{repoName(card.repo)}</span> : null}
          {slug ? <span class="slug">{slug}</span> : null}
        </div>
      ) : null}
      <CardBadges card={card} now={props.now} />
    </div>
  );
}
