/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const shared = fileURLToPath(new URL('../src/shared', import.meta.url));

export default defineConfig(({ command }) => {
  // `vite build` always ships production React. A NODE_ENV inherited from the caller (vitest sets "test")
  // would otherwise make the React plugin emit development JSX (jsxDEV).
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    plugins: [react()],
    base: '/',
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: '../dist/ui',
      emptyOutDir: true,
      target: 'es2020',
      chunkSizeWarningLimit: 1200,
    },
    test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node', setupFiles: ['src/test-setup.ts'] },
  };
});
