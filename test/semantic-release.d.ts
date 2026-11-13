// The commit analyzer ships no types. Only the call the workflow test makes is described.
declare module '@semantic-release/commit-analyzer' {
  interface Logger {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  }
  export function analyzeCommits(
    pluginConfig: Record<string, unknown>,
    context: { commits: { hash: string; message: string }[]; logger: Logger; cwd: string },
  ): Promise<'major' | 'minor' | 'patch' | null>;
}
