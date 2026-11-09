// The verbs. Each takes parsed arguments and a context, and returns the JSON to print. The board decides everything that
// matters (who holds a card, whether a pass is allowed); this file only works out where the agent is and what it holds.
import { Api, type Reply } from './api.ts';
import { flag, flagAll, has, type Parsed, UsageError } from './args.ts';
import { resolveConfig } from './credentials.ts';
import { CliError, detectCheckout, notACheckout, stateFile, type Checkout, type Located } from './git.ts';
import {
  freshState,
  lastBeat,
  readState,
  removeState,
  stampBeat,
  writeState,
  type HeldCard,
  type WorktreeState,
} from './state.ts';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** Pauses between retries of a failed request; tests shorten them. */
  backoffMs?: number[] | undefined;
}

export const HEARTBEAT_MIN_INTERVAL_MS = 60_000;

export class Context {
  readonly io: Io;
  readonly args: Parsed;
  #api: Api | undefined;
  #checkout: Checkout | undefined;
  #located: Promise<Located | undefined> | undefined;
  constructor(io: Io, args: Parsed) {
    this.io = io;
    this.args = args;
  }

  now(): number {
    return (this.io.now ?? Date.now)();
  }

  async api(): Promise<Api> {
    if (!this.#api) {
      const { url, token } = await resolveConfig(this.io.env);
      this.#api = new Api({
        url,
        token,
        fetch: this.io.fetch,
        sleep: this.io.sleep,
        backoffMs: this.io.backoffMs,
      });
    }
    return this.#api;
  }

  async get<T = Record<string, any>>(path: string, query?: Record<string, string | undefined>): Promise<Reply<T>> {
    return (await this.api()).get<T>(path, query);
  }

  async post<T = Record<string, any>>(path: string, body?: unknown): Promise<Reply<T>> {
    return (await this.api()).post<T>(path, body);
  }

  async checkout(): Promise<Checkout> {
    this.#checkout ??= await detectCheckout(this.io.cwd, this.io.env);
    return this.#checkout;
  }

  /** The worktree and where it keeps its state; undefined outside a git checkout. Needs no remote. */
  locate(): Promise<Located | undefined> {
    this.#located ??= stateFile(this.io.cwd);
    return this.#located;
  }

  async located(): Promise<Located> {
    const found = await this.locate();
    if (!found) throw notACheckout(this.io.cwd);
    return found;
  }

  async worktree(): Promise<string> {
    return (await this.located()).worktree;
  }

  /** The state file and what it holds, or a fresh state when there is none yet. Needs only a git checkout. */
  async state(): Promise<{ path: string; state: WorktreeState }> {
    const { statePath } = await this.located();
    return { path: statePath, state: (await readState(statePath)) ?? freshState(this.io.env) };
  }
}

const usage = (message: string) => new UsageError(message);

// A card is named by its id, by its full key (owner/name/slug) or by its slug in this checkout's repo.
const CARD_ID = /^[0-9a-z]{13}$/;

export interface CardRef {
  id: string;
  key: string | null;
}

export async function resolveCard(ctx: Context, ref: string | undefined): Promise<CardRef> {
  if (ref === undefined) {
    const { state } = await ctx.state();
    if (!state.held) {
      throw new CliError(
        'no_card',
        'No card is held in this worktree. Name the card (its id, owner/name/slug, or the slug alone), or run `baton take <card>` first.',
        1,
      );
    }
    return { id: state.held.card, key: state.held.key };
  }
  if (CARD_ID.test(ref)) return { id: ref, key: null };
  let key = ref;
  const slashes = ref.split('/').length - 1;
  if (slashes === 0) key = `${(await ctx.checkout()).repo}/${ref}`;
  else if (slashes !== 2) {
    throw usage(`"${ref}" is not a card: use its id, owner/name/slug, or the slug alone.`);
  }
  const { body } = await ctx.get<{ cards: { id: string; key: string | null }[] }>('/cards', { key });
  const found = body.cards[0];
  if (!found) {
    throw new CliError('not_found', `No card has the key ${key}. List the repo's cards with \`baton list\`.`, 1);
  }
  return { id: found.id, key: found.key };
}

async function resolveProject(ctx: Context, repo: string): Promise<{ id: string; name: string }> {
  const { body } = await ctx.get<{ projects: { id: string; name: string }[] }>('/projects', { repo, counts: '0' });
  const project = body.projects[0];
  if (!project) {
    throw new CliError(
      'repo_unregistered',
      `Repo ${repo} belongs to no project. Register it with \`baton project register --name "<project name>"\`: that creates the project, or adds this repo to the project of that name.`,
      1,
    );
  }
  return project;
}

const keyOf = (card: CardRef): string => card.key ?? card.id;

export const PROJECT_USAGE = 'Usage: baton project register --name <name> [--repo owner/name]...';
export const HOOK_USAGE = 'Usage: baton hook heartbeat | baton hook stop';

export async function projectRegister(ctx: Context) {
  const name = flag(ctx.args, 'name');
  if (!name) throw usage(PROJECT_USAGE);
  let repos = flagAll(ctx.args, 'repo');
  if (repos.length === 0) repos = [(await ctx.checkout()).repo];
  const api = await ctx.api();
  // Registering again from a repo the project already holds changes nothing, so it succeeds rather than refuse.
  const existing = await api.get<{ projects: { id: string; name: string; repos: string[] }[] }>('/projects', {
    repo: repos[0] as string,
    counts: '0',
  });
  const held = existing.body.projects[0];
  if (held && held.name.toLowerCase() === name.trim().toLowerCase() && repos.every((r) => held.repos.includes(r))) {
    return { project: held, created: false, added: [] };
  }
  return (await api.post('/projects', { name, repos, ifExists: 'add' })).body;
}

export async function list(ctx: Context) {
  const { repo } = await ctx.checkout();
  const project = await resolveProject(ctx, repo);
  const column = flag(ctx.args, 'column');
  const { body } = await ctx.get<{ cards: { column: string; state: string }[] }>('/cards', { repo, column });
  const state = flag(ctx.args, 'state');
  const cards = body.cards.filter(
    (c) => (has(ctx.args, 'all') || column !== undefined || c.column !== 'done') && (!state || c.state === state),
  );
  return { repo, project, cards };
}

export async function create(ctx: Context) {
  const title = flag(ctx.args, 'title') ?? ctx.args.positional.join(' ');
  if (!title.trim())
    throw usage(
      'Usage: baton create --title <title> [--body <text>] [--column <column>] [--key <slug>] [--link <url>]...',
    );
  const repo = flag(ctx.args, 'repo') ?? (await ctx.checkout()).repo;
  const payload: Record<string, unknown> = { repo, title };
  const body = flag(ctx.args, 'body');
  const column = flag(ctx.args, 'column');
  const key = flag(ctx.args, 'key');
  const links = flagAll(ctx.args, 'link');
  if (body !== undefined) payload.body = body;
  if (column) payload.column = column;
  if (key) payload.key = key;
  if (links.length > 0) payload.links = links;
  return (await ctx.post('/cards', payload)).body;
}

export async function take(ctx: Context) {
  const ref = ctx.args.positional[0];
  if (!ref) throw usage('Usage: baton take <card> [--to <column> | --no-move]');
  const to = flag(ctx.args, 'to');
  if (to === 'in_review' || to === 'done') {
    throw usage(
      'take moves a card to backlog, ready, in_progress, blocked only. When the work is done, run `baton pass --to <column>` to hand it over.',
    );
  }
  const checkout = await ctx.checkout();
  await resolveProject(ctx, checkout.repo);
  const card = await resolveCard(ctx, ref);
  const { path, state } = await ctx.state();
  const payload: Record<string, unknown> = {
    repo: checkout.repo,
    worktree: checkout.worktree,
    branch: checkout.branch,
    session: state.session,
  };
  // A card taken from Backlog or Ready moves to In progress; one already further along stays where it is.
  if (!has(ctx.args, 'no-move')) payload.to = to ?? 'in_progress';
  const { body } = await ctx.post<{ card: { id: string; key: string | null }; warnings: unknown[] }>(
    `/cards/${card.id}/claim`,
    payload,
  );
  const previous = state.held;
  await writeState(path, { ...state, held: { card: body.card.id, key: body.card.key, branch: checkout.branch } });
  await stampBeat(path, ctx.now());
  if (previous && previous.card !== body.card.id) {
    body.warnings.push({
      code: 'second_card',
      message: `This worktree already held ${previous.key ?? previous.card}. Heartbeats now go to ${keyOf(card)} only, so the earlier card will go stale. Release it with \`baton drop ${previous.key ?? previous.card}\` if you are done with it, or use another worktree per card.`,
    });
  }
  return body;
}

/** Extends the lease of `cardId`, and restarts the minute the heartbeat hook waits when this worktree holds it. */
async function beat(ctx: Context, cardId: string) {
  const { body } = await ctx.post(`/cards/${cardId}/heartbeat`, { worktree: await ctx.worktree() });
  const { path, state } = await ctx.state();
  if (state.held?.card === cardId) await stampBeat(path, ctx.now());
  return body;
}

export async function heartbeat(ctx: Context) {
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  return beat(ctx, card.id);
}

export async function check(ctx: Context) {
  const ref = ctx.args.positional[0];
  const api = await ctx.api();
  if (ref === undefined) {
    // What needs this agent: the cards it was last on that a human has written to since it last acknowledged, or moved back.
    const { body } = await api.get('/cards', { attention: 'me' });
    return body;
  }
  const card = await resolveCard(ctx, ref);
  const detail = await api.get<{ card: { key: string | null; ackedSeq: number; seq: number; unread: boolean } }>(
    `/cards/${card.id}`,
  );
  const events = await api.get<{
    events: { seq: number; actor: { kind: string }; type: string }[];
    seq: number;
  }>(`/cards/${card.id}/events`, { since: String(detail.body.card.ackedSeq) });
  const pending = events.body.events.filter((e) => e.actor.kind === 'human' && e.type !== 'created');
  const seq = Math.max(events.body.seq, ...events.body.events.map((e) => e.seq));
  try {
    const { path, state } = await ctx.state();
    await writeState(path, { ...state, checked: { ...state.checked, [card.id]: seq } });
  } catch {
    // Not in a checkout: the check still reads, but `ack` will then need --seq.
  }
  const key = detail.body.card.key ?? card.id;
  return {
    card: detail.body.card,
    pending,
    seq,
    next: detail.body.card.unread
      ? `Read the ${pending.length} event(s) in "pending", answer or act on them, then run: baton ack ${key}`
      : 'Nothing from a human is waiting. You can pass or drop the card.',
  };
}

export async function ack(ctx: Context) {
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  const given = flag(ctx.args, 'seq');
  let seq = given === undefined ? undefined : Number(given);
  seq ??= await ctx.state().then(
    ({ state }) => state.checked[card.id],
    // Not in a checkout: nothing was recorded, so only --seq can say what was read.
    () => undefined,
  );
  if (seq === undefined || !Number.isInteger(seq) || seq < 0) {
    throw new CliError(
      'nothing_checked',
      `Nothing is recorded as read for ${keyOf(card)}. Run \`baton check ${keyOf(card)}\` and read what it returns, then \`baton ack ${keyOf(card)}\`; or pass --seq <n> for the sequence you have read.`,
      1,
    );
  }
  return (await ctx.post(`/cards/${card.id}/ack`, { seq })).body;
}

export async function comment(ctx: Context) {
  const given = flag(ctx.args, 'text');
  const [ref, ...rest] = ctx.args.positional;
  // With --text the positional, if any, names the card. Without it the first names the card and the rest is the text.
  const text = given ?? rest.join(' ');
  if (!text.trim() || (given === undefined && ref === undefined)) {
    throw usage('Usage: baton comment <card> <text...>   or   baton comment [<card>] --text <text>');
  }
  const card = await resolveCard(ctx, ref);
  return (await ctx.post(`/cards/${card.id}/comments`, { text })).body;
}

export async function move(ctx: Context) {
  const to = flag(ctx.args, 'to');
  if (!to) throw usage('Usage: baton move <card> --to <column>');
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  return (await ctx.post(`/cards/${card.id}/move`, { to, worktree: await ctx.worktree() })).body;
}

async function release(ctx: Context, reason: string, to: string | undefined) {
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  const payload: Record<string, unknown> = { worktree: await ctx.worktree(), reason };
  if (to) payload.to = to;
  const note = flag(ctx.args, 'comment');
  if (note) payload.comment = note;
  const { body } = await ctx.post(`/cards/${card.id}/release`, payload);
  const { path, state } = await ctx.state();
  if (state.held?.card === card.id) await writeState(path, { ...state, held: null });
  return body;
}

export const pass = (ctx: Context) => release(ctx, 'done', flag(ctx.args, 'to') ?? 'in_review');

export function drop(ctx: Context) {
  const reason = flag(ctx.args, 'reason') ?? 'paused';
  if (reason !== 'paused' && reason !== 'blocked') {
    throw usage(
      `--reason must be paused or blocked (got "${reason}"). Use \`baton pass\` when the work is done; session_ended is sent by the stop hook.`,
    );
  }
  return release(ctx, reason, undefined);
}

/** A card the board no longer lets this agent hold: taken over, or gone. */
const lostCard = (error: unknown): error is CliError =>
  error instanceof CliError && (error.code === 'not_holder' || error.code === 'not_found');

interface HookRun {
  statePath: string;
  state: WorktreeState;
  held: HeldCard;
}

/** Runs from the hooks: never throws, because a hook that fails must not disturb the session it watches. */
async function runHook(name: string, ctx: Context, body: (run: HookRun) => Promise<unknown>): Promise<unknown> {
  try {
    const located = await ctx.locate();
    if (!located) return undefined;
    const state = await readState(located.statePath);
    if (!state?.held) return undefined;
    return await body({ statePath: located.statePath, state, held: state.held });
  } catch (error) {
    ctx.io.stderr(`baton hook ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

export const hookHeartbeat = (ctx: Context): Promise<unknown> =>
  runHook('heartbeat', ctx, async ({ statePath, state, held }) => {
    const now = ctx.now();
    const last = await lastBeat(statePath);
    if (last !== undefined && now - last < HEARTBEAT_MIN_INTERVAL_MS) return undefined;
    // Claim the minute before sending, so parallel tool calls in one burst send one heartbeat.
    await stampBeat(statePath, now);
    try {
      return await beat(ctx, held.card);
    } catch (error) {
      if (lostCard(error)) {
        await writeState(statePath, { ...state, held: null });
        ctx.io.stderr(`baton: ${error.message}\n`);
      }
      throw error;
    }
  });

export const hookStop = (ctx: Context): Promise<unknown> =>
  runHook('stop', ctx, async ({ statePath, held }) => {
    const note = `Session ended while this card was held (branch ${held.branch}). The stop hook released it, so the work may be unfinished: check the branch before taking it up.`;
    try {
      const { body } = await ctx.post(`/cards/${held.card}/release`, {
        worktree: await ctx.worktree(),
        reason: 'session_ended',
        comment: note,
      });
      await removeState(statePath);
      return body;
    } catch (error) {
      // Lost the card already, or it is gone: there is nothing left to release.
      if (lostCard(error)) await removeState(statePath);
      throw error;
    }
  });
