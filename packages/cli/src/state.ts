// What this worktree remembers between commands: the card it holds, so the hooks need no arguments, the session label, and
// the sequence each `check` showed, so `ack` acknowledges what was read and not what arrived since. One JSON file in the
// worktree's own git directory, so a linked worktree has its own and nothing is committed.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface HeldCard {
  card: string;
  key: string | null;
  repo: string;
  branch: string;
  takenAt: number;
  /** When the last heartbeat was sent, for the once-a-minute limit. */
  heartbeatAt: number;
}

export interface WorktreeState {
  /** The session label sent with claims: CLAUDE_SESSION_ID when set, else made once here. */
  session: string;
  held: HeldCard | null;
  /** card id -> the sequence `baton check` last showed for it. */
  checked: Record<string, number>;
}

const MAX_CHECKED = 20;

export async function readState(path: string): Promise<WorktreeState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<WorktreeState>;
    if (typeof parsed.session !== 'string') return undefined;
    return { session: parsed.session, held: parsed.held ?? null, checked: parsed.checked ?? {} };
  } catch {
    return undefined;
  }
}

export const freshState = (env: NodeJS.ProcessEnv): WorktreeState => ({
  session: env.CLAUDE_SESSION_ID?.trim() || `local-${randomBytes(6).toString('hex')}`,
  held: null,
  checked: {},
});

export async function writeState(path: string, state: WorktreeState): Promise<void> {
  const entries = Object.entries(state.checked);
  const trimmed = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_CHECKED)));
  await mkdir(dirname(path), { recursive: true });
  // Write beside the file and rename, so a hook reading while a command writes never sees half a file.
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}`;
  await writeFile(temp, `${JSON.stringify({ ...state, checked: trimmed })}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function removeState(path: string): Promise<void> {
  await rm(path, { force: true });
}
