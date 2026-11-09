import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  // Preact's automatic JSX runtime; no plugin needed.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: resolve(import.meta.dirname, '../assets/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
