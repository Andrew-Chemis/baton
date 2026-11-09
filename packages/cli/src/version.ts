// Replaced with the package version by scripts/build.ts; a source checkout reports "dev".
/* oxlint-disable eslint/no-underscore-dangle -- the name is the one esbuild's `define` replaces */
declare const __BATON_VERSION__: string | undefined;
export const VERSION: string = typeof __BATON_VERSION__ === 'string' ? __BATON_VERSION__ : 'dev';
/* oxlint-enable eslint/no-underscore-dangle */
