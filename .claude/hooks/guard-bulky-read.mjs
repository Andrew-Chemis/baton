#!/usr/bin/env node
// Claude Code PreToolUse hook for the Read tool: refuses a whole-file read of
// a bulky generated file, and tells the agent to grep it or read a range.
//
// Why: a lockfile, changelog, generated workflow, snapshot or synthesized
// template is thousands of lines that an agent almost never needs whole, and a
// single unbounded Read of one can cost tens of thousands of tokens.
//
// How it stays safe:
// - Only the paths in BULKY are guarded. Every other file reads as usual.
// - A Read that passes `limit` is always allowed, so the agent can still see
//   any part of the file; it just has to say which part.
// - It only ever denies; it never auto-approves anything.
// - CLAUDE_FULL_OUTPUT=1 in the environment disables it, and any error inside
//   the hook exits 0 with no output, which allows the read.
//
// Copies live in several repos; cdk-constructs holds the canonical one. Change
// it there and copy it out, so every copy stays identical.

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Generated or append-only files that are rarely needed whole. */
const BULKY = [
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)CHANGELOG\.md$/,
  /(?:^|\/)\.github\/workflows\/deploy(?:-[\w-]+)?\.yml$/,
  /(?:^|\/)__snapshots__\//,
  /(?:^|\/)cdk\.out\//,
  /\.template\.json$/,
  /(?:^|\/)coverage\//,
  /(?:^|\/)test-reports\//,
];

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

/** Files smaller than this read whole even when they match BULKY. */
const MIN_BYTES = 8 * 1024;

function recordStats(before, what) {
  try {
    const file = statsFile();
    mkdirSync(dirname(file), { recursive: true });
    const row = [new Date().toISOString(), 'guard-bulky-read', before, 0, what];
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
  const path = input.tool_input?.file_path;
  if (
    input.tool_name !== 'Read' ||
    typeof path !== 'string' ||
    input.tool_input.limit !== undefined ||
    !BULKY.some((re) => re.test(path))
  ) {
    return;
  }
  const size = statSync(path).size;
  if (size < MIN_BYTES) return;
  recordStats(size, path);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${path} is a bulky generated file (${Math.round(size / 1024)} KB). ` +
          'Grep it for what you need (Grep with -n, or `grep -n`), then Read ' +
          'with offset and limit around the match. A Read that passes limit ' +
          'is always allowed.',
      },
    }),
  );
}

main().catch(() => {
  // Fail open: the read goes ahead.
});
