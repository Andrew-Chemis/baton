#!/usr/bin/env node
// Claude Code PostToolUse hook for the Bash tool: compacts the output of
// successful runs of noisy build tooling before the agent reads it.
//
// Why: a passing `pnpm build`, `git push` (with its pre-push hook), `pnpm
// projen` or `cdk deploy` prints hundreds of lines of status text the agent
// never needs, and every line is paid for in context tokens. Only failures
// need the detail.
//
// How it stays safe:
// - Claude Code fires PostToolUse only when the command exits 0. A failing
//   command never reaches this hook, so failure output is never touched.
// - Only commands on the NOISY list below are compacted, and only when every
//   step of the command line is noisy (or plumbing such as `cd`). Commands
//   whose output is the point (`git diff`, `cdk diff`, `cat`, `grep`, `gh pr
//   view`, ...) pass through, as does anything piped or redirected, since the
//   agent already shaped that output itself.
// - Output under the size threshold passes through unchanged.
// - The full output is written to a log file named in the compacted result,
//   so nothing is lost: read it with the Read tool (offset/limit) or grep it.
// - Warning, error and deprecation lines are kept (deduplicated), along with
//   the last lines of the run, where summaries and stack outputs land.
// - Any error inside this hook exits 0 with no output, which leaves the
//   original output in place.
//
// Opt out for one command by prefixing it with CLAUDE_FULL_OUTPUT=1, or for a
// whole session by exporting CLAUDE_FULL_OUTPUT=1 before starting Claude Code.
//
// Copies live in several repos; cdk-constructs holds the canonical one. Change
// it there and copy it out, so every copy stays identical.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Compact only output longer than this many lines or characters. */
const MAX_LINES = 40;
const MAX_CHARS = 4000;
/** Notable lines kept from the body of the output. */
const MAX_NOTABLE = 25;
/** Lines kept from the end of the output. */
const TAIL_LINES = 15;
/** Logs older than this are pruned on each run. */
const LOG_TTL_MS = 24 * 60 * 60 * 1000;

const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const PM_OPTS = String.raw`(?:\s+(?:--filter[= ]\S+|-F\s+\S+|-C\s+\S+|--dir[= ]\S+|--prefix[= ]\S+|-w|--workspace[= ]\S+|-r|--recursive|-s|--silent|--prefer-offline|--frozen-lockfile|--offline))*`;
/**
 * Package scripts whose successful output is status text. A suffixed variant
 * (`test:credit-cards`, `deploy:iam`, `type-check:website`) matches too.
 * `diff` and `report` are deliberately absent: their output is content.
 */
const SCRIPTS = [
  'build',
  'bundle',
  'check',
  'ci',
  'clean',
  'compile',
  'default',
  'deploy',
  'destroy',
  'format',
  'i',
  'install',
  'lint',
  'package',
  'post-compile',
  'pre-compile',
  'projen',
  'synth',
  'test',
  'type-check',
  'typecheck',
  'upgrade',
];
/** Binaries run through `pnpm exec` or `npx`. */
const BINARIES =
  '(?:vitest(?:\\s+run)?|jest|oxlint|oxfmt|eslint|prettier|tsc|projen|lint-staged|husky)';

/** Commands whose successful output is status text, not content. */
const NOISY = [
  String.raw`(?:pnpm|npm)${PM_OPTS}(?:\s+run)?\s+(?:${SCRIPTS.join('|')})(?::[\w:-]+)?`,
  String.raw`(?:pnpm${PM_OPTS}\s+(?:exec\s+)?|npx\s+)${BINARIES}`,
  String.raw`(?:pnpm${PM_OPTS}\s+(?:exec\s+)?|npx\s+)?cdk\s+(?:synth|deploy|bootstrap|destroy)`,
  String.raw`pnpm${PM_OPTS}\s+exec\s+tsx\s+\S*\.projenrc\.ts`,
  String.raw`git\s+(?:push|pull|fetch|commit|clone|rebase|merge|cherry-pick|checkout|switch)`,
  String.raw`gh\s+run\s+watch`,
  String.raw`mise\s+install`,
  String.raw`node\s+\S*run-pipeline-step\.mjs`,
].map((src) => new RegExp(String.raw`^${ENV_PREFIX}${src}(?:\s|$)`));

/** Steps that print nothing worth keeping and may join noisy steps. */
const PLUMBING = new RegExp(
  String.raw`^(?:cd|pushd|popd|export|unset|set|source|\.|true|:|mkdir)(?:\s|$)`,
);

const NOTABLE = new RegExp(
  [
    // Test-run summaries, so a compacted run still says how many tests ran.
    String.raw`^(?:Test Files|Tests|Test Suites|Snapshots)\b:?\s+\d`,
    String.raw`\bwarn(?:ing)?s?\b`,
    String.raw`\berrors?\b`,
    String.raw`\bfail(?:s|ed|ing|ure)?\b`,
    String.raw`\bdeprecat\w*`,
    String.raw`\bvulnerabilit\w*`,
    String.raw`\bskipp(?:ed|ing)\b`,
    '⚠',
    '❌',
    '✗',
  ].join('|'),
  'i',
);

/**
 * Lines that match NOTABLE without being a problem: passing test names
 * ("✓ warns for ..."), task echoes ("$ oxlint --max-warnings=0") and bare file
 * paths from a pack listing (lib/aspects/deprecated-construct-aspect.js).
 */
const IGNORED = /^(?:[✓√]|\$ |👾)|^[\w./@-]+\.(?:[cm]?js|d\.ts|ts|map|json)$/;

// Built from a string so no linter's no-control-regex rule needs a waiver.
const ANSI = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);

function isNoisy(command) {
  if (/(?:^|\s)CLAUDE_FULL_OUTPUT=1(?:\s|$)/.test(command)) return false;
  // Piped, redirected, substituted or multi-line: the agent shaped it already.
  if (/[|<>`\n]|\$\(/.test(command.replace(/\|\||2>&1|&&/g, ''))) {
    return false;
  }
  const steps = command
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter(Boolean);
  let sawNoisy = false;
  for (const step of steps) {
    if (NOISY.some((re) => re.test(step))) sawNoisy = true;
    else if (!PLUMBING.test(step)) return false;
  }
  return sawNoisy;
}

function writeLog(command, stdout, stderr) {
  const dir = process.env.CLAUDE_OUTPUT_DIR || join(tmpdir(), 'claude-output');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > LOG_TTL_MS) unlinkSync(file);
    } catch {
      // Raced with another session's prune; nothing to do.
    }
  }
  const slug = command
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const file = join(dir, `${now}-${process.pid}-${slug}.log`);
  const body = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  writeFileSync(file, body);
  return file;
}

function compact(command, stdout, stderr) {
  const text = (stderr ? `${stdout}\n${stderr}` : stdout).replace(ANSI, '');
  const lines = text.split('\n');
  if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) return undefined;

  const tail = lines.slice(-TAIL_LINES).filter((l) => l.trim() !== '');
  const tailSet = new Set(tail.map((l) => l.trim()));
  const counts = new Map();
  for (const line of lines.slice(0, -TAIL_LINES)) {
    const key = line.trim();
    if (!key || tailSet.has(key) || IGNORED.test(key) || !NOTABLE.test(key)) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const notable = [...counts].map(([l, n]) => (n > 1 ? `${l}  (x${n})` : l));
  const shown = notable.slice(0, MAX_NOTABLE);
  if (notable.length > shown.length) {
    shown.push(
      `... ${notable.length - shown.length} more distinct notable lines in the log`,
    );
  }

  const log = writeLog(command, stdout, stderr);
  const kb = (text.length / 1024).toFixed(1);
  return [
    `[compact-output] Exit 0. ${lines.length} lines (${kb} KB) compacted. Full output: ${log}`,
    '[compact-output] Read the log with offset/limit or grep it if you need more; prefix the command with CLAUDE_FULL_OUTPUT=1 to see everything.',
    ...(shown.length
      ? ['--- warnings/errors seen (deduplicated) ---', ...shown]
      : []),
    `--- last ${tail.length} lines ---`,
    ...tail,
  ].join('\n');
}

/**
 * Where savings rows go. Cloud sessions run in throwaway containers, so the
 * home directory is lost when the session ends; a Claude project's shared
 * folder (/mnt/project-files) outlives them, so it wins when present.
 * CLAUDE_OUTPUT_STATS overrides both.
 */
function statsFile() {
  if (process.env.CLAUDE_OUTPUT_STATS) return process.env.CLAUDE_OUTPUT_STATS;
  if (existsSync('/mnt/project-files/')) {
    return '/mnt/project-files/output-compaction/output-stats.tsv';
  }
  return join(homedir(), '.claude', 'output-stats.tsv');
}

/**
 * Append one row per compaction to a TSV (time, hook, chars before, chars
 * after, command), so savings can be measured in real use rather than
 * estimated. `column -t -s $'\t' <file>` reads it (see statsFile); the
 * read guard (guard-bulky-read.mjs) writes to the same file.
 */
function recordStats(before, after, what) {
  try {
    const file = statsFile();
    mkdirSync(dirname(file), { recursive: true });
    const row = [
      new Date().toISOString(),
      'compact-output',
      before,
      after,
      what.replace(/\s+/g, ' ').slice(0, 120),
    ];
    appendFileSync(file, `${row.join('\t')}\n`);
  } catch {
    // Stats are best effort; never fail the hook over them.
  }
}

async function main() {
  if (process.env.CLAUDE_FULL_OUTPUT === '1') return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const response = input.tool_response;
  const command = input.tool_input?.command;
  if (
    input.tool_name !== 'Bash' ||
    typeof command !== 'string' ||
    input.tool_input.run_in_background ||
    !response ||
    typeof response.stdout !== 'string' ||
    response.interrupted ||
    response.isImage ||
    !isNoisy(command.trim())
  ) {
    return;
  }
  const out = compact(command, response.stdout, response.stderr ?? '');
  if (out === undefined) return;
  recordStats(
    response.stdout.length + (response.stderr ?? '').length,
    out.length,
    command,
  );
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { ...response, stdout: out, stderr: '' },
      },
    }),
  );
}

main().catch(() => {
  // Fail open: the original output stays in place.
});
