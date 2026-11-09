import { useEffect, useRef, useState } from 'preact/hooks';
import { ClaimedIcon } from './icons.tsx';
import { api, messageOf } from './api.ts';
import { CardBadges } from './badges.tsx';
import { usePoll } from './hooks.ts';
import { notify } from './toast.tsx';
import { COLUMNS, type CardView, type Column, type EventView } from './types.ts';
import { ago, COLUMN_LABEL, span, when } from './util.ts';

interface Detail {
  card: CardView;
  events: EventView[];
}

export function describeEvent(e: EventView): string {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case 'created':
      return 'created the card';
    case 'edited':
      return p.archived
        ? 'archived the card'
        : `edited ${
            Object.keys(p)
              .filter((k) => k !== 'archived')
              .join(', ') || 'the card'
          }`;
    case 'moved':
      return `moved it from ${COLUMN_LABEL[p.from as Column] ?? p.from} to ${COLUMN_LABEL[p.to as Column] ?? p.to}`;
    case 'commented':
      return 'commented';
    case 'claimed':
      return `took it on ${p.branch ?? 'a branch'} in ${p.worktree ?? 'a worktree'}`;
    case 'taken_over':
      return `took it over from ${p.previous?.agentId ?? 'another agent'} (${p.previous?.branch ?? '?'})`;
    case 'released':
      return `released it: ${String(p.reason ?? '').replace(/_/g, ' ')}${p.to ? `, moved to ${COLUMN_LABEL[p.to as Column] ?? p.to}` : ''}`;
    default:
      return String(e.type);
  }
}

export function Drawer(props: { cardId: string; onClose: () => void; onChanged: () => void }) {
  const { cardId } = props;
  const detail = usePoll<Detail>(async () => {
    const [{ card }, { events }] = await Promise.all([
      api.get<{ card: CardView }>(`/cards/${cardId}`),
      api.get<{ events: EventView[] }>(`/cards/${cardId}/events`),
    ]);
    return { card, events };
  }, cardId);
  const card = detail.data?.card;
  const events = detail.data?.events ?? [];
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  const changed = async () => {
    await detail.reload();
    props.onChanged();
  };

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="drawer" role="dialog" aria-modal="true" aria-label="Card details" tabIndex={-1} ref={root}>
        <header class="drawer-head">
          <h2>{card?.title ?? 'Card'}</h2>
          <button type="button" class="plain" onClick={props.onClose} aria-label="Close card">
            ×
          </button>
        </header>
        {detail.error ? (
          <p class="error" role="alert">
            {detail.error}
          </p>
        ) : null}
        {card ? (
          <div class="drawer-body">
            <CardBadges card={card} now={Date.now()} />
            <Facts card={card} />
            <EditForm key={`${card.id}:${card.seq}`} card={card} onSaved={changed} />
            <MoveArchive card={card} onChanged={changed} />
            <h3>Activity</h3>
            <CommentBox cardId={card.id} onPosted={changed} />
            <ol class="events">
              {events.toReversed().map((e) => (
                <li key={e.seq} class={`event by-${e.actor.kind} ${e.type}`}>
                  <div class="event-head">
                    <strong>{e.actor.id}</strong> {describeEvent(e)}
                    <time dateTime={new Date(e.at).toISOString()} title={when(e.at)}>
                      {ago(e.at)}
                    </time>
                  </div>
                  {e.type === 'commented' ? (
                    <p class="comment-text">{(e.payload as { text?: string }).text ?? ''}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p class="muted pad">Loading…</p>
        )}
      </div>
    </div>
  );
}

function Facts({ card }: { card: CardView }) {
  const claim = card.claim;
  const last = card.lastClaim;
  return (
    <dl class="facts">
      <dt>Repo</dt>
      <dd>{card.repo}</dd>
      {card.key ? (
        <>
          <dt>Key</dt>
          <dd class="mono">{card.key}</dd>
        </>
      ) : null}
      <dt>Column</dt>
      <dd>{COLUMN_LABEL[card.column]}</dd>
      {claim ? (
        <>
          <dt>{card.state === 'stale' ? 'Last held by' : 'Held by'}</dt>
          <dd>
            <ClaimedIcon /> {claim.agentId}
          </dd>
          <dt>Branch</dt>
          <dd class="mono">{claim.branch}</dd>
          <dt>Worktree</dt>
          <dd class="mono wrap">{claim.worktree}</dd>
          {claim.session ? (
            <>
              <dt>Session</dt>
              <dd class="mono wrap">{claim.session}</dd>
            </>
          ) : null}
          <dt>Heartbeat</dt>
          <dd>
            {ago(claim.heartbeatAt)}
            {claim.stale ? ` (lease ran out ${span(Date.now() - claim.leaseUntil)} ago)` : ''}
          </dd>
        </>
      ) : last ? (
        <>
          <dt>Last held by</dt>
          <dd>
            {last.agentId} on <span class="mono">{last.branch}</span>, released {ago(last.endedAt)} (
            {last.reason ?? last.endedBy})
          </dd>
          <dt>Worktree</dt>
          <dd class="mono wrap">{last.worktree}</dd>
        </>
      ) : null}
      {card.links.length > 0 ? (
        <>
          <dt>Links</dt>
          <dd>
            {card.links.map((l) => (
              <a key={l} href={l} rel="noreferrer noopener" target="_blank" class="wrap">
                {l}
              </a>
            ))}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function EditForm({ card, onSaved }: { card: CardView; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = title !== card.title || body !== (card.body ?? '');
  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/cards/${card.id}`, {
        ...(title !== card.title ? { title } : {}),
        ...(body !== (card.body ?? '') ? { body } : {}),
      });
      await onSaved();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} class="edit">
      <label class="field">
        Title
        <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={200} required />
      </label>
      <label class="field">
        Details
        <textarea value={body} onInput={(e) => setBody(e.currentTarget.value)} rows={5} maxLength={20000} />
      </label>
      <div class="actions">
        <button type="submit" disabled={!dirty || busy || !title.trim()}>
          Save changes
        </button>
      </div>
    </form>
  );
}

function MoveArchive({ card, onChanged }: { card: CardView; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="row move-row">
      <label class="field">
        Move to
        <select
          value={card.column}
          disabled={busy}
          onChange={(e) => {
            const to = e.currentTarget.value;
            void run(() => api.post(`/cards/${card.id}/move`, { to }));
          }}
        >
          {COLUMNS.map((c) => (
            <option key={c} value={c}>
              {COLUMN_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      {card.archived ? (
        <span class="muted">Archived</span>
      ) : (
        <button
          type="button"
          class="danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`Archive "${card.title}"? ${card.claim ? 'Its claim is released.' : ''}`))
              void run(() => api.post(`/cards/${card.id}/archive`));
          }}
        >
          Archive
        </button>
      )}
    </div>
  );
}

function CommentBox({ cardId, onPosted }: { cardId: string; onPosted: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async (event?: Event) => {
    event?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post(`/cards/${cardId}/comments`, { text });
      setText('');
      await onPosted();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={post} class="comment-box">
      <label class="field">
        <span class="sr-only">Comment</span>
        <textarea
          value={text}
          rows={3}
          placeholder="Comment for the agent working on this. It sees it the next time it checks."
          maxLength={10000}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
          }}
        />
      </label>
      <div class="actions">
        <button type="submit" class="primary" disabled={busy || !text.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}
