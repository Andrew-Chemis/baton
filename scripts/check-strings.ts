// Fails when the published packages or the workflows carry something account-specific: a 12-digit number (an AWS account id
// has that shape), an ARN, or the owner's domain. Scans packages/ outside test directories and build output, and .github/.
// The spec, the README and docs/ are outside the check so they can name the consuming repository.
//   node scripts/check-strings.ts [root]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

// Built from pieces so this file does not trip the check on itself if it is ever moved under packages/.
const RULES: { rule: string; pattern: RegExp }[] = [
  { rule: '12-digit account-shaped number', pattern: /(?<![0-9])[0-9]{12}(?![0-9])/ },
  { rule: 'ARN', pattern: new RegExp(['arn', 'aws'].join(':'), 'i') },
  { rule: "owner's domain", pattern: new RegExp(['andrewchemis', 'dev'].join('\\.'), 'i') },
];

const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', 'lib', 'dist', 'cdk.out', 'coverage', '.vite']);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|tgz|gz|zip|pdf)$/i;

function* walk(dir: string, root: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    // Built output: the Lambda bundle carries the AWS SDK's own strings; its sources are what the check reads.
    if (rel.startsWith('packages/') && (rel.endsWith('/assets/api') || rel.endsWith('/assets/web'))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full, root);
    } else if (!BINARY.test(name)) {
      yield full;
    }
  }
}

export function scan(root: string): Violation[] {
  const found: Violation[] = [];
  for (const top of ['packages', '.github']) {
    const start = join(root, top);
    try {
      statSync(start);
    } catch {
      continue;
    }
    for (const file of walk(start, root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        for (const { rule, pattern } of RULES) {
          if (pattern.test(text))
            found.push({ file: relative(root, file), line: index + 1, rule, text: text.trim().slice(0, 120) });
        }
      });
    }
  }
  return found;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const violations = scan(root);
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.rule}: ${v.text}`);
  if (violations.length > 0) {
    console.error(
      `\n${violations.length} account-specific string(s) found. Nothing account-specific belongs in the published packages or workflows.`,
    );
    process.exit(1);
  }
  console.log('check-strings: clean');
}
