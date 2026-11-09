// Entry logic, apart from process globals so tests can drive it: parse, dispatch, print JSON, return an exit code.
//   0  done
//   1  the board refused, or could not be reached; the JSON on stderr says what to do next
//   2  the command could not start: bad usage, not in a git checkout, no token or address
import { parseArgs, UsageError } from './args.ts';
import * as commands from './commands.ts';
import { Context, type Io } from './commands.ts';
import { CliError } from './git.ts';
import { VERSION } from './version.ts';

const BOOLEANS = ['all', 'no-move', 'help', 'version'];

export const HELP = `baton ${VERSION}: claim, heartbeat, check and pass cards on a Baton board from a git checkout.

  baton project register --name <name> [--repo owner/name]...
  baton list [--column <column>] [--state claimed|stale|unowned|unclaimed] [--all]
  baton create --title <title> [--body <text>] [--column <column>] [--key <slug>] [--link <url>]...
  baton take <card> [--to <column> | --no-move]
  baton heartbeat [<card>]
  baton check [<card>]             no card: what needs you; a card: its unread human events
  baton ack [<card>] [--seq <n>]   acknowledge what the last "check <card>" showed
  baton comment <card> <text...>
  baton move <card> --to <column>
  baton pass [<card>] [--to <column>] [--comment <text>]    release as done; default column in_review
  baton drop [<card>] [--reason paused|blocked] [--comment <text>]
  baton hook heartbeat | stop      for the Claude Code hooks

A card is its id, owner/name/slug, or the slug alone. Omit it to use the card this worktree holds.
Every command prints JSON: the result on stdout, or {"error":{"code","message",...}} on stderr.
Environment: BATON_URL, BATON_TOKEN (else SSM /baton/agent-token and /baton/url when AWS credentials exist).
`;

type Verb = (ctx: Context) => unknown;

/** What each command word runs. A word with subcommands of its own maps them one level down, with the usage a wrong one gets. */
const COMMANDS: Record<string, Verb | { usage: string; run: Record<string, Verb> }> = {
  list: commands.list,
  create: commands.create,
  take: commands.take,
  heartbeat: commands.heartbeat,
  check: commands.check,
  ack: commands.ack,
  comment: commands.comment,
  move: commands.move,
  pass: commands.pass,
  drop: commands.drop,
  project: { usage: commands.PROJECT_USAGE, run: { register: commands.projectRegister } },
  hook: { usage: commands.HOOK_USAGE, run: { heartbeat: commands.hookHeartbeat, stop: commands.hookStop } },
};

/** The word is typed by a person or a model, so only the table's own entries count: `constructor` is not a command. */
function pick(verb: string, rest: string[]): { handler: Verb; positional: string[] } {
  const found = Object.hasOwn(COMMANDS, verb) ? COMMANDS[verb] : undefined;
  if (!found) throw new UsageError(`Unknown command "${verb}".`);
  if (typeof found === 'function') return { handler: found, positional: rest };
  const [sub, ...tail] = rest;
  const handler = sub !== undefined && Object.hasOwn(found.run, sub) ? found.run[sub] : undefined;
  if (!handler) throw new UsageError(found.usage);
  return { handler, positional: tail };
}

const printError = (io: Io, error: Record<string, unknown>): void =>
  io.stderr(`${JSON.stringify({ error }, null, 2)}\n`);

function fail(io: Io, error: unknown): number {
  if (error instanceof UsageError) {
    printError(io, { code: 'usage', message: `${error.message} Run \`baton --help\` for the commands.` });
    return 2;
  }
  if (error instanceof CliError) {
    printError(io, { ...error.extra, code: error.code, message: error.message });
    return error.exit;
  }
  printError(io, {
    code: 'internal',
    message: `Unexpected failure: ${error instanceof Error ? error.message : String(error)}. Repeat the command; if it persists, report it with this message.`,
  });
  return 1;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv, BOOLEANS);
    if (args.flags.has('version')) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    const [verb, ...rest] = args.positional;
    if (!verb || verb === 'help' || args.flags.has('help')) {
      io.stdout(HELP);
      return verb || args.flags.has('help') ? 0 : 2;
    }
    const { handler, positional } = pick(verb, rest);
    const result = await handler(new Context(io, { ...args, positional }));
    // A hook has nothing to say when it did nothing.
    if (result !== undefined) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}
