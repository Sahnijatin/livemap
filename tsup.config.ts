import { defineConfig } from 'tsup';

// Two builds share dist/, so each cleans only its own output (the UI build empties dist/ui itself).
export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node18',
    clean: ['cli.js*'],
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // Agent hook: one self-contained file (node: built-ins only), run as `node hook.mjs <agent> <event>`.
    entry: { hook: 'src/hook/hook.ts' },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    clean: ['hook.mjs*'],
    outExtension: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    removeNodeProtocol: false,
    splitting: false,
  },
]);
