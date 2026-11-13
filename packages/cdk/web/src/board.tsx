import { useMemo, useRef, useState } from 'preact/hooks';
import { comparePos } from '../../service/rank.ts';
import { api, messageOf } from './api.ts';
import { CardTile, type TilePointerEvent } from './card-tile.tsx';
import { tally } from './counts.ts';
import { Drawer } from './drawer.tsx';
import { positionAt, useCardDrag, type Drag } from './dnd.ts';
import { ErrorNote } from './error-note.tsx';
import { useAction, usePoll } from './hooks.ts';
import { Link, navigate, type Route } from './router.tsx';
import { ProjectSettings } from './settings.tsx';
import { notify } from './toast.tsx';
import { COLUMNS, type CardView, type Column, type ProjectView } from './types.ts';
import { COLUMN_LABEL } from './util.ts';

interface Pending {
  column: Column;
  pos: string | undefined;
}

/** Sorts after any real position: a card whose move has no position yet waits at the end of its column. */
const END = String.fromCharCode(0xffff);

export function Board(props: { projectId: string; route: Route }) {
  const { projectId, route } = props;
  const repoFilter = route.query.get('repo') ?? '';
  const openId = route.query.get('card');
  const [archived, setArchived] = useState(false);
  const [panel, setPanel] = useState<'new' | 'settings' | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const scroller = useRef<HTMLDivElement>(null);

  // Counts are worked out from the cards below, so the board does not ask the API for them.
  const projects = usePoll(() => api.get<{ projects: ProjectView[] }>('/projects?counts=0'), 'projects');
  const cards = usePoll(
    () =>
      api.get<{ cards: CardView[] }>(`/cards?project=${encodeURIComponent(projectId)}${archived ? '&archived=1' : ''}`),
    `${projectId}:${archived}`,
  );
  const project = projects.data?.projects.find((p) => p.id === projectId);
  const now = Date.now();
  // Cards and project move together: after a change, both are read again. The cards come back first.
  const reloadAll = () => {
    const loaded = cards.reload();
    void projects.reload();
    return loaded;
  };

  const columns = useMemo(() => {
    const merged: CardView[] = [];
    for (const c of cards.data?.cards ?? []) {
      const p = pending[c.id];
      merged.push(p ? Object.assign({}, c, { column: p.column, pos: p.pos ?? END }) : c);
    }
    const shown = repoFilter ? merged.filter((c) => c.repo === repoFilter) : merged;
    return COLUMNS.map((col) => [col, shown.filter((c) => c.column === col).toSorted(comparePos)] as const);
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
      await reloadAll();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setPending((p) => {
        const { [card.id]: _gone, ...rest } = p;
        return rest;
      });
    }
  }

  const { drag, ghost, wasDrag, tileEvents } = useCardDrag({
    scroller,
    onDrop: (card, col, index) => void drop(card, col, index),
  });

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

  const counts = cards.data ? tally(cards.data.cards) : undefined;
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
            await reloadAll();
          }}
        />
      ) : null}
      {panel === 'settings' && project ? (
        <ProjectSettings project={project} onChanged={() => void reloadAll()} />
      ) : null}

      <ErrorNote text={cards.error} />

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
            <ColumnCards
              col={col}
              list={list}
              drag={drag}
              now={now}
              showRepo={showRepo}
              onOpen={(card) => {
                if (!wasDrag()) setQuery({ card: card.id });
              }}
              tileEvents={tileEvents}
            />
          </section>
        ))}
      </div>

      {ghost ? (
        <div class="ghost-layer" aria-hidden="true">
          <div
            class="ghost-pos"
            style={{ left: `${ghost.x - ghost.dx}px`, top: `${ghost.y - ghost.dy}px`, width: `${ghost.width}px` }}
          >
            <CardTile card={ghost.card} now={now} showRepo={showRepo} ghost />
          </div>
        </div>
      ) : null}

      {openId ? (
        <Drawer
          key={openId}
          cardId={openId}
          onClose={() => setQuery({ card: null })}
          onChanged={() => void reloadAll()}
        />
      ) : null}
    </main>
  );
}

/** One column's tiles, with the line that shows where a dragged card would land. */
function ColumnCards(props: {
  col: Column;
  list: CardView[];
  drag: Drag | null;
  now: number;
  showRepo: boolean;
  onOpen: (card: CardView) => void;
  tileEvents: (card: CardView) => {
    onPointerDown: (event: TilePointerEvent) => void;
    onPointerMove: (event: TilePointerEvent) => void;
    onPointerUp: (event: TilePointerEvent) => void;
    onPointerCancel: (event: TilePointerEvent) => void;
  };
}) {
  const { col, list, drag } = props;
  const visible = list.filter((c) => c.id !== drag?.card.id);
  const items = list.flatMap((card) => {
    const slot = card.id === drag?.card.id ? -1 : visible.indexOf(card);
    const line = drag?.col === col && slot === drag.index ? [<div class="drop-line" key={`line-${card.id}`} />] : [];
    return [
      ...line,
      <CardTile
        key={card.id}
        card={card}
        now={props.now}
        showRepo={props.showRepo}
        dragging={drag?.card.id === card.id}
        onOpen={() => props.onOpen(card)}
        {...props.tileEvents(card)}
      />,
    ];
  });
  if (drag?.col === col && drag.index >= visible.length) items.push(<div class="drop-line" key="line-end" />);
  return (
    <div class="column-cards">
      {list.length === 0 && drag?.col !== col ? <p class="empty">Nothing here</p> : null}
      {items}
    </div>
  );
}

function NewCard(props: { project: ProjectView; defaultRepo: string; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [repo, setRepo] = useState(props.defaultRepo || props.project.repos[0] || '');
  const [column, setColumn] = useState<Column>('backlog');
  const { busy, run } = useAction();
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!title.trim() || !repo) return;
    await run(async () => {
      await api.post('/cards', { repo, title: title.trim(), body, column });
      await props.onDone();
    });
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
