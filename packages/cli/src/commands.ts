// The verbs. Each takes parsed arguments and a context, and returns the JSON to print. The board decides everything that
// matters (who holds a card, whether a pass is allowed); this file only works out where the agent is and what it holds.
import { Api } from './api.ts';
import { flag, flagAll, has, type Parsed, UsageError } from './args.ts';
import { resolveConfig } from './credentials.ts';
import { CliError, detectCheckout, stateFile, type Checkout } from './git.ts';
import { freshState, readState, removeState, writeState, type WorktreeState } from './state.ts';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Pauses between retries of a failed request; tests shorten them. */
  backoffMs?: number[];
}

export const HEARTBEAT_MIN_INTERVAL_MS = 60_000;

export class Context {
  readonly io: Io;
  readonly args: Parsed;
  #api: Api | undefined;
  #checkout: Checkout | undefined;
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
        ...(this.io.fetch ? { fetch: this.io.fetch } : {}),
        ...(this.io.sleep ? { sleep: this.io.sleep } : {}),
        ...(this.io.backoffMs ? { backoffMs: this.io.backoffMs } : {}),
      });
    }
    return this.#api;
  }

  async checkout(): Promise<Checkout> {
    this.#checkout ??= await detectCheckout(this.io.cwd, this.io.env);
    return this.#checkout;
  }

  /** The state file and what it holds, or a fresh state when there is none yet. Needs only a git checkout. */
  async state(): Promise<{ path: string; state: WorktreeState }> {
    const located = await stateFile(this.io.cwd);
    if (!located) {
      throw new CliError(
        'not_a_checkout',
        `${this.io.cwd} is not inside a git checkout. Run baton from the repository you are working in.`,
      );
    }
    return { path: located.statePath, state: (await readState(located.statePath)) ?? freshState(this.io.env) };
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
  const { body } = await (await ctx.api()).get<{ cards: { id: string; key: string | null }[] }>('/cards', { key });
  const found = body.cards[0];
  if (!found) {
    throw new CliError('not_found', `No card has the key ${key}. List the repo's cards with \`baton list\`.`, 1);
  }
  return { id: found.id, key: found.key };
}

async function resolveProject(ctx: Context, repo: string): Promise<{ id: string; name: string }> {
  const { body } = await (
    await ctx.api()
  ).get<{ projects: { id: string; name: string }[] }>('/projects', {
    repo,
    counts: '0',
  });
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

export async function projectRegister(ctx: Context) {
  const name = flag(ctx.args, 'name');
  if (!name) throw usage('Usage: baton project register --name <name> [--repo owner/name]...');
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
  const { body } = await (
    await ctx.api()
  ).get<{ cards: { column: string; state: string }[] }>('/cards', {
    repo,
    column,
  });
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
  return (await (await ctx.api()).post('/cards', payload)).body;
}

export async function take(ctx: Context) {
  const ref = ctx.args.positional[0];
  if (!ref) throw usage('Usage: baton take <card> [--to <column> | --no-move]');
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
  if (!has(ctx.args, 'no-move')) payload.to = flag(ctx.args, 'to') ?? 'in_progress';
  const { body } = await (
    await ctx.api()
  ).post<{ card: { id: string; key: string | null }; warnings: unknown[] }>(`/cards/${card.id}/claim`, payload);
  const previous = state.held;
  const now = ctx.now();
  await writeState(path, {
    ...state,
    held: {
      card: body.card.id,
      key: body.card.key,
      repo: checkout.repo,
      branch: checkout.branch,
      takenAt: now,
      heartbeatAt: now,
    },
  });
  if (previous && previous.card !== body.card.id) {
    body.warnings.push({
      code: 'second_card',
      message: `This worktree already held ${previous.key ?? previous.card}. Heartbeats now go to ${keyOf(card)} only, so the earlier card will go stale. Release it with \`baton drop ${previous.key ?? previous.card}\` if you are done with it, or use another worktree per card.`,
    });
  }
  return body;
}

export async function heartbeat(ctx: Context) {
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  const checkout = await ctx.checkout();
  const { body } = await (await ctx.api()).post(`/cards/${card.id}/heartbeat`, { worktree: checkout.worktree });
  const { path, state } = await ctx.state();
  if (state.held?.card === card.id)
    await writeState(path, { ...state, held: { ...state.held, heartbeatAt: ctx.now() } });
  return body;
}

export async function check(ctx: Context) {
  const ref = ctx.args.positional[0];
  const api = await ctx.api();
  if (ref === undefined) {
    // What needs this agent: the cards it was last on that have human activity it has not acknowledged, and its stale claims.
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
  let seq: number | undefined = given === undefined ? undefined : Number(given);
  if (seq === undefined) {
    try {
      seq = (await ctx.state()).state.checked[card.id];
    } catch {
      seq = undefined;
    }
  }
  if (seq === undefined || !Number.isInteger(seq) || seq < 0) {
    throw new CliError(
      'nothing_checked',
      `Nothing is recorded as read for ${keyOf(card)}. Run \`baton check ${keyOf(card)}\` and read what it returns, then \`baton ack ${keyOf(card)}\`; or pass --seq <n> for the sequence you have read.`,
      1,
    );
  }
  return (await (await ctx.api()).post(`/cards/${card.id}/ack`, { seq })).body;
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
  return (await (await ctx.api()).post(`/cards/${card.id}/comments`, { text })).body;
}

export async function move(ctx: Context) {
  const to = flag(ctx.args, 'to');
  if (!to) throw usage('Usage: baton move <card> --to <column>');
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  const checkout = await ctx.checkout();
  return (await (await ctx.api()).post(`/cards/${card.id}/move`, { to, worktree: checkout.worktree })).body;
}

async function release(ctx: Context, reason: string, to: string | undefined) {
  const card = await resolveCard(ctx, ctx.args.positional[0]);
  const checkout = await ctx.checkout();
  const payload: Record<string, unknown> = { worktree: checkout.worktree, reason };
  if (to) payload.to = to;
  const note = flag(ctx.args, 'comment');
  if (note) payload.comment = note;
  const { body } = await (await ctx.api()).post(`/cards/${card.id}/release`, payload);
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

/** Runs from the hooks: never throws, because a hook that fails must not disturb the session it watches. */
export async function hook(ctx: Context): Promise<unknown> {
  const which = ctx.args.positional[0];
  if (which !== 'heartbeat' && which !== 'stop') throw usage('Usage: baton hook heartbeat | baton hook stop');
  try {
    const located = await stateFile(ctx.io.cwd);
    if (!located) return undefined;
    const state = await readState(located.statePath);
    const held = state?.held;
    if (!state || !held) return undefined;
    if (which === 'heartbeat') {
      const now = ctx.now();
      if (now - held.heartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return undefined;
      // Claim the minute before sending, so parallel tool calls in one burst send one heartbeat.
      await writeState(located.statePath, { ...state, held: { ...held, heartbeatAt: now } });
      try {
        const { body } = await (await ctx.api()).post(`/cards/${held.card}/heartbeat`, { worktree: located.worktree });
        return body;
      } catch (error) {
        if (error instanceof CliError && (error.code === 'not_holder' || error.code === 'not_found')) {
          await writeState(located.statePath, { ...state, held: null });
          ctx.io.stderr(`baton: ${error.message}\n`);
        }
        throw error;
      }
    }
    const note = `Session ended while this card was held (branch ${held.branch}). The stop hook released it, so the work may be unfinished: check the branch before taking it up.`;
    try {
      const { body } = await (
        await ctx.api()
      ).post(`/cards/${held.card}/release`, {
        worktree: located.worktree,
        reason: 'session_ended',
        comment: note,
      });
      await removeState(located.statePath);
      return body;
    } catch (error) {
      // Lost the card already, or it is gone: there is nothing left to release.
      if (error instanceof CliError && (error.code === 'not_holder' || error.code === 'not_found')) {
        await removeState(located.statePath);
      }
      throw error;
    }
  } catch (error) {
    ctx.io.stderr(`baton hook ${which}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}
