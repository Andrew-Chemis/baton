import type { Column } from './types.ts';

export const COLUMN_LABEL: Record<Column, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
};

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A length of time without "ago": "12m", "3h". */
export function span(ms: number): string {
  const text = ago(0, Math.max(0, ms));
  return text === 'just now' ? '<1m' : text.replace(' ago', '');
}

export const when = (at: number): string => new Date(at).toLocaleString();

export function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** localStorage that never throws: private windows and blocked storage just forget. */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // nothing to do: the setting is simply not remembered
    }
  },
};
