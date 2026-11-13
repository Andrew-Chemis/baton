import { run } from './run.ts';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
