// A small argv parser: `--name value`, `--name=value`, `--flag`, and positionals. Flags named in `booleans` take no value.
export interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], booleans: readonly string[] = []): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (booleans.includes(name)) {
      value = 'true';
    } else {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`--${name} needs a value`);
      value = next;
      i += 1;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

export const flag = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.at(-1);
export const flagAll = (p: Parsed, name: string): string[] => p.flags.get(name) ?? [];
export const has = (p: Parsed, name: string): boolean => p.flags.has(name);
