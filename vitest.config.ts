import { defineConfig } from 'vitest/config';

// One config for the workspace; each project names its own files, environment and global setup. `test` runs every project
// except `pack` (it builds both packages and installs them with npm); `test:pack` runs that one.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'service',
          include: ['packages/cdk/test/service/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['packages/cdk/test/support/dynamodb-global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'cdk-synth',
          include: ['packages/cdk/test/synth/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['packages/cdk/test/support/build-assets-global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
        test: {
          name: 'web',
          include: ['packages/cdk/test/web/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'cli',
          include: ['packages/cli/test/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['packages/cdk/test/support/dynamodb-global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'scripts',
          include: ['test/**/*.test.ts'],
          exclude: ['test/pack.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'pack',
          include: ['test/pack.test.ts'],
          environment: 'node',
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
