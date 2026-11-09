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

const VERBS: Record<string, (ctx: Context) => unknown> = {
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
  hook: commands.hook,
};

function fail(io: Io, error: unknown): number {
  if (error instanceof UsageError) {
    io.stderr(
      `${JSON.stringify({ error: { code: 'usage', message: `${error.message} Run \`baton --help\` for the commands.` } }, null, 2)}\n`,
    );
    return 2;
  }
  if (error instanceof CliError) {
    io.stderr(`${JSON.stringify({ error: { ...error.extra, code: error.code, message: error.message } }, null, 2)}\n`);
    return error.exit;
  }
  io.stderr(
    `${JSON.stringify({ error: { code: 'internal', message: `Unexpected failure: ${error instanceof Error ? error.message : String(error)}. Repeat the command; if it persists, report it with this message.` } }, null, 2)}\n`,
  );
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
    let result: unknown;
    if (verb === 'project') {
      const [sub, ...tail] = rest;
      if (sub !== 'register')
        throw new UsageError('Usage: baton project register --name <name> [--repo owner/name]...');
      result = await commands.projectRegister(new Context(io, { ...args, positional: tail }));
    } else {
      const handler = VERBS[verb];
      if (!handler) throw new UsageError(`Unknown command "${verb}".`);
      result = await handler(new Context(io, { ...args, positional: rest }));
    }
    // A hook has nothing to say when it did nothing.
    if (result !== undefined) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}
