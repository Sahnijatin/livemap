import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const shared = fileURLToPath(new URL('../src/shared', import.meta.url));
const inlineWorker = fileURLToPath(new URL('./src/layout/elkWorker.inline.ts', import.meta.url));

// `livemap export` UI: one HTML file that opens offline from file://. Every chunk, dynamic import, the
// stylesheet, the fonts (as data URIs) and the ELK worker are inlined; the CLI embeds the history into it,
// and the highlighting grammars an export needs (scripts/export-grammars.mjs writes them next to the page).

/** Fontsource's `.woff` fallbacks dropped: every browser that runs the export reads woff2. */
const woff2Only = (): Plugin => ({
  name: 'livemap-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/@fontsource[\\/].*\.css$/.test(id)) return;
    return { code: code.replace(/,\s*url\([^)]*\.woff\) format\('woff'\)/g, ''), map: null };
  },
});

export default defineConfig(({ command }) => {
  // Production React regardless of an inherited NODE_ENV (see vite.config.ts).
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    // main.tsx keeps its export boot only in this mode.
    mode: 'export',
    plugins: [react(), woff2Only(), viteSingleFile({ removeViteModuleLoader: true })],
    base: './',
    resolve: {
      alias: [
        { find: '@shared', replacement: shared },
        { find: /^\.\/elkWorker$/, replacement: inlineWorker },
      ],
    },
    build: {
      outDir: '../dist/ui-export',
      emptyOutDir: true,
      target: 'es2020',
      chunkSizeWarningLimit: 10_000,
    },
  };
});
