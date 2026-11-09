// Dragging a card: which slot the pointer is over, the position string that puts the card there, and the pointer state
// machine that turns presses, moves and releases on the tiles into one drop.
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { between } from '../../service/rank.ts';
import type { TilePointerEvent } from './card-tile.tsx';
import type { CardView, Column } from './types.ts';

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

/** What the board shows while a card is being dragged: the card, where the pointer is, and the slot it is over. */
export interface Drag {
  card: CardView;
  x: number;
  y: number;
  /** Where inside the card the pointer took hold. */
  dx: number;
  dy: number;
  width: number;
  col: Column | null;
  index: number;
}

/** A pointer that is down on a tile. It becomes a drag once it has moved `THRESHOLD` pixels. */
type Press = Omit<Drag, 'card'> & { id: string; pointerId: number; active: boolean; cancelled: boolean };

const THRESHOLD = 5;

/**
 * The pointer events of every tile on the board, and the drag they add up to. `onDrop` hears the card, the column it was let
 * go over and the slot among that column's other cards; Escape or a cancelled pointer ends the drag without it.
 */
export function useCardDrag(options: {
  scroller: RefObject<HTMLElement | null>;
  onDrop: (card: CardView, col: Column, index: number) => void;
}) {
  const { scroller, onDrop } = options;
  const [drag, setDrag] = useState<Drag | null>(null);
  // Kept in a ref as well as in `drag`, so a release needs no re-render to know where the pointer is.
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);

  function begin(event: TilePointerEvent, card: CardView) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest('a, input, select, textarea')) return;
    // A finger starts a drag only from the grip, so the rest of the card still scrolls the board.
    if (event.pointerType === 'touch' && !target.closest('.grip')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    press.current = {
      id: card.id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      width: rect.width,
      active: false,
      cancelled: false,
      col: null,
      index: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: TilePointerEvent, card: CardView) {
    const p = press.current;
    if (!p || p.id !== card.id || p.cancelled) return;
    if (!p.active && Math.hypot(event.clientX - p.x, event.clientY - p.y) < THRESHOLD) return;
    p.active = true;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const columnEl = under?.closest<HTMLElement>('[data-col]');
    let col: Column | null = null;
    let index = 0;
    if (columnEl) {
      col = columnEl.dataset.col as Column;
      const mids = [...columnEl.querySelectorAll<HTMLElement>('.card:not(.dragging):not(.ghost)')].map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      index = slotAt(mids, event.clientY);
    }
    const box = scroller.current;
    if (box) {
      const edge = box.getBoundingClientRect();
      if (event.clientX < edge.left + 40) box.scrollBy({ left: -14 });
      else if (event.clientX > edge.right - 40) box.scrollBy({ left: 14 });
    }
    p.col = col;
    p.index = index;
    setDrag({ card, x: event.clientX, y: event.clientY, dx: p.dx, dy: p.dy, width: p.width, col, index });
  }

  function end(event: TilePointerEvent, card: CardView, cancelled: boolean) {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== card.id) return;
    try {
      event.currentTarget.releasePointerCapture(p.pointerId);
    } catch {
      // already released
    }
    if (!p.active && !p.cancelled) return;
    // The browser follows a drag's pointerup with a click on the card; that click is not a request to open it.
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    setDrag(null);
    if (!cancelled && !p.cancelled && p.col) onDrop(card, p.col, p.index);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && press.current?.active) {
        press.current.cancelled = true;
        setDrag(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return {
    drag,
    /** The drag, once the press has become one: what the floating copy of the card follows. */
    ghost: drag && press.current?.active ? drag : null,
    /** True for the click that closes a drag. */
    wasDrag: () => suppressClick.current,
    /** The four pointer handlers a tile takes. */
    tileEvents: (card: CardView) => ({
      onPointerDown: (e: TilePointerEvent) => begin(e, card),
      onPointerMove: (e: TilePointerEvent) => move(e, card),
      onPointerUp: (e: TilePointerEvent) => end(e, card, false),
      onPointerCancel: (e: TilePointerEvent) => end(e, card, true),
    }),
  };
}
