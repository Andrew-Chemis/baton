import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, messageOf } from './api.ts';
import { CardTile, type TilePointerEvent } from './card-tile.tsx';
import { Drawer } from './drawer.tsx';
import { positionAt, slotAt } from './dnd.ts';
import { usePoll } from './hooks.ts';
import { Link, navigate, type Route } from './router.tsx';
import { ProjectSettings } from './settings.tsx';
import { notify } from './toast.tsx';
import { COLUMNS, type CardView, type Column, type ProjectView } from './types.ts';
import { COLUMN_LABEL } from './util.ts';

interface Drag {
  card: CardView;
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  col: Column | null;
  index: number;
}

interface Pending {
  column: Column;
  pos: string | undefined;
}

const THRESHOLD = 5;
/** Sorts after any real position: a card whose move has no position yet waits at the end of its column. */
const END = String.fromCharCode(0xffff);
const byPos = (a: CardView, b: CardView) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1);

export function Board(props: { projectId: string; route: Route }) {
  const { projectId, route } = props;
  const repoFilter = route.query.get('repo') ?? '';
  const openId = route.query.get('card');
  const [archived, setArchived] = useState(false);
  const [panel, setPanel] = useState<'new' | 'settings' | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    width: number;
    active: boolean;
    cancelled: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  const projects = usePoll(() => api.get<{ projects: ProjectView[] }>('/projects'), 'projects');
  const cards = usePoll(
    () =>
      api.get<{ cards: CardView[] }>(`/cards?project=${encodeURIComponent(projectId)}${archived ? '&archived=1' : ''}`),
    `${projectId}:${archived}`,
  );
  const project = projects.data?.projects.find((p) => p.id === projectId);
  const now = Date.now();

  const columns = useMemo(() => {
    const merged: CardView[] = [];
    for (const c of cards.data?.cards ?? []) {
      const p = pending[c.id];
      merged.push(p ? Object.assign({}, c, { column: p.column, pos: p.pos ?? END }) : c);
    }
    const shown = repoFilter ? merged.filter((c) => c.repo === repoFilter) : merged;
    return COLUMNS.map((col) => [col, shown.filter((c) => c.column === col).toSorted(byPos)] as const);
  }, [cards.data, pending, repoFilter]);

  const showRepo = (project?.repos.length ?? 0) > 1 && !repoFilter;

  async function drop(card: CardView, col: Column, index: number) {
    const others = (columns.find(([c]) => c === col)?.[1] ?? []).filter((c) => c.id !== card.id);
    const current = (columns.find(([c]) => c === card.column)?.[1] ?? []).findIndex((c) => c.id === card.id);
    if (col === card.column && index === current) return;
    const pos = positionAt(others, index);
    setPending((p) => ({ ...p, [card.id]: { column: col, pos } }));
    try {
      await api.post(`/cards/${card.id}/move`, { to: col, ...(pos ? { pos } : {}) });
      await cards.reload();
      void projects.reload();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setPending((p) => {
        const { [card.id]: _gone, ...rest } = p;
        return rest;
      });
    }
  }

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
    const finished = drag;
    setDrag(null);
    if (!cancelled && !p.cancelled && finished?.col) void drop(card, finished.col, finished.index);
  }

  useEffect(() => {
    if (!drag) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (press.current) press.current.cancelled = true;
        setDrag(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const setQuery = (changes: Record<string, string | null>) => {
    const q = new URLSearchParams(route.query);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') q.delete(k);
      else q.set(k, v);
    }
    const text = q.toString();
    navigate(`${route.path}${text ? `?${text}` : ''}`);
  };

  if (projects.data && !project) {
    return (
      <main class="page">
        <h1>No such project</h1>
        <p>
          This project does not exist or was archived. <Link href="/">Back to the dashboard</Link>
        </p>
      </main>
    );
  }

  const counts = project?.counts;
  return (
    <main class="page board-page">
      <div class="board-head">
        <div class="board-title">
          <Link href="/" class="crumb">
            Projects
          </Link>
          <h1>{project?.name ?? '…'}</h1>
        </div>
        {counts ? (
          <ul class="count-row" aria-label="Project summary">
            <li class={`chip claimed${counts.claimed ? '' : ' zero'}`}>{counts.claimed} claimed</li>
            <li class={`chip stale${counts.stale ? '' : ' zero'}`}>{counts.stale} stale</li>
            <li class={`chip unowned${counts.unowned ? '' : ' zero'}`}>{counts.unowned} unowned</li>
            <li class={`chip reopened${counts.reopened ? '' : ' zero'}`}>{counts.reopened} reopened</li>
            <li class={`chip unread${counts.unread ? '' : ' zero'}`}>{counts.unread} unread</li>
          </ul>
        ) : null}
        <div class="board-tools">
          <label class="field inline">
            <span class="sr-only">Filter by repo</span>
            <select
              value={repoFilter}
              onChange={(e) => setQuery({ repo: e.currentTarget.value })}
              aria-label="Filter by repo"
            >
              <option value="">All repos</option>
              {(project?.repos ?? []).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.currentTarget.checked)} /> Archived
          </label>
          <button
            type="button"
            onClick={() => setPanel(panel === 'new' ? null : 'new')}
            aria-expanded={panel === 'new'}
          >
            New card
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            aria-expanded={panel === 'settings'}
          >
            Settings
          </button>
        </div>
      </div>

      {panel === 'new' && project ? (
        <NewCard
          project={project}
          defaultRepo={repoFilter}
          onDone={async () => {
            setPanel(null);
            await cards.reload();
            void projects.reload();
          }}
        />
      ) : null}
      {panel === 'settings' && project ? (
        <ProjectSettings
          project={project}
          onChanged={() => {
            void projects.reload();
            void cards.reload();
          }}
        />
      ) : null}

      {cards.error ? (
        <p class="error" role="alert">
          {cards.error}
        </p>
      ) : null}

      <div class="columns" ref={scroller} data-dragging={drag ? 'true' : undefined}>
        {columns.map(([col, list]) => (
          <section
            class={`column${drag?.col === col ? ' over' : ''}`}
            key={col}
            data-col={col}
            aria-label={COLUMN_LABEL[col]}
          >
            <header>
              <h2>{COLUMN_LABEL[col]}</h2>
              <span class="count">{list.length}</span>
            </header>
            <div class="column-cards">
              {list.length === 0 && drag?.col !== col ? <p class="empty">Nothing here</p> : null}
              {(() => {
                const visible = list.filter((c) => c.id !== drag?.card.id);
                const items = list.flatMap((card) => {
                  const slot = card.id === drag?.card.id ? -1 : visible.indexOf(card);
                  const line =
                    drag?.col === col && slot === drag.index ? [<div class="drop-line" key={`line-${card.id}`} />] : [];
                  return [
                    ...line,
                    <CardTile
                      key={card.id}
                      card={card}
                      now={now}
                      showRepo={showRepo}
                      dragging={drag?.card.id === card.id}
                      onOpen={() => {
                        if (!suppressClick.current) setQuery({ card: card.id });
                      }}
                      onPointerDown={(e) => begin(e, card)}
                      onPointerMove={(e) => move(e, card)}
                      onPointerUp={(e) => end(e, card, false)}
                      onPointerCancel={(e) => end(e, card, true)}
                    />,
                  ];
                });
                if (drag?.col === col && drag.index >= visible.length)
                  items.push(<div class="drop-line" key="line-end" />);
                return items;
              })()}
            </div>
          </section>
        ))}
      </div>

      {drag && press.current?.active ? (
        <div class="ghost-layer" aria-hidden="true">
          <div
            class="ghost-pos"
            style={{ left: `${drag.x - drag.dx}px`, top: `${drag.y - drag.dy}px`, width: `${drag.width}px` }}
          >
            <CardTile card={drag.card} now={now} showRepo={showRepo} ghost />
          </div>
        </div>
      ) : null}

      {openId ? (
        <Drawer
          key={openId}
          cardId={openId}
          onClose={() => setQuery({ card: null })}
          onChanged={() => {
            void cards.reload();
            void projects.reload();
          }}
        />
      ) : null}
    </main>
  );
}

function NewCard(props: { project: ProjectView; defaultRepo: string; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [repo, setRepo] = useState(props.defaultRepo || props.project.repos[0] || '');
  const [column, setColumn] = useState<Column>('backlog');
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!title.trim() || !repo) return;
    setBusy(true);
    try {
      await api.post('/cards', { repo, title: title.trim(), body, column });
      await props.onDone();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="panel new-card" onSubmit={submit}>
      <h2>New card</h2>
      {props.project.repos.length === 0 ? (
        <p class="error">This project holds no repo yet. Add one in Settings first.</p>
      ) : null}
      <label class="field">
        Title
        <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={200} required autofocus />
      </label>
      <div class="row">
        <label class="field">
          Repo
          <select value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
            {props.project.repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label class="field">
          Column
          <select value={column} onChange={(e) => setColumn(e.currentTarget.value as Column)}>
            {COLUMNS.filter((c) => c !== 'done').map((c) => (
              <option key={c} value={c}>
                {COLUMN_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label class="field">
        Details
        <textarea value={body} onInput={(e) => setBody(e.currentTarget.value)} rows={4} maxLength={20000} />
      </label>
      <div class="actions">
        <button type="submit" class="primary" disabled={busy || !title.trim() || !repo}>
          Create card
        </button>
      </div>
    </form>
  );
}
