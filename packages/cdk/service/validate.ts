import { badRequest } from './errors.ts';

export function asObject(value: unknown, what = 'request body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw badRequest(`The ${what} must be a JSON object.`);
  return value as Record<string, unknown>;
}

export function text(
  value: unknown,
  field: string,
  options: { min?: number; max: number; optional?: boolean } = { max: 200 },
): string | undefined {
  if (value === undefined || value === null) {
    if (options.optional) return undefined;
    throw badRequest(`${field} is required.`);
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  const min = options.min ?? 1;
  if (value.trim().length < min) throw badRequest(`${field} must not be empty.`);
  if (value.length > options.max) throw badRequest(`${field} must be at most ${options.max} characters.`);
  return value;
}

export function requiredText(value: unknown, field: string, max: number): string {
  return text(value, field, { max }) as string;
}

export function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw badRequest(`${field} must be a list of strings.`);
  if (value.length > maxItems) throw badRequest(`${field} may hold at most ${maxItems} entries.`);
  for (const v of value as string[])
    if (v.length === 0 || v.length > maxLength)
      throw badRequest(`${field} entries must be 1 to ${maxLength} characters.`);
  return value as string[];
}

/** `owner/name` from a URL, an scp-style remote or a bare slug; lower-cased. */
export function normalizeRepo(input: unknown, field = 'repo'): string {
  if (typeof input !== 'string' || input.trim() === '') throw badRequest(`${field} is required, as owner/name.`);
  let path = input.trim();
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(path);
  if (scp) {
    path = scp[1] as string;
  } else if (path.includes('://')) {
    try {
      path = new URL(path).pathname;
    } catch {
      throw badRequest(`${field} "${input}" is not a repository URL; use owner/name.`);
    }
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = path.split('/').filter(Boolean);
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name || ![owner, name].every((p) => /^[A-Za-z0-9._-]+$/.test(p))) {
    throw badRequest(`${field} "${input}" must look like owner/name.`);
  }
  return `${owner}/${name}`.toLowerCase();
}

export function normalizeName(input: unknown): { name: string; nameKey: string } {
  const raw = requiredText(input, 'name', 60);
  // oxlint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw badRequest('name must not contain control characters.');
  const name = raw.trim().replace(/\s+/g, ' ');
  return { name, nameKey: name.toLowerCase() };
}
