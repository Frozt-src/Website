import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Invoked as `vite --config app/portal/vite.config.ts` from the repo root, so `root` is set to
// this file's own directory rather than relying on Vite's cwd-based default.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../dist/portal',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8788' },
  },
});
