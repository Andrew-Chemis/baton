import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(count: number): string {
  const bytes = randomBytes(count);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Time-ordered id: eight base-36 digits of the millisecond clock, then five random ones. */
export function newId(now: number): string {
  return now.toString(36).padStart(8, '0') + randomChars(5);
}

/** A bearer token: 32 random bytes, base64url. The prefix lets a leaked token be recognised by secret scanners. */
export function newToken(): string {
  return `baton_${randomBytes(32).toString('base64url')}`;
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'project';
}

export { randomChars };
