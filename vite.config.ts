import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages cannot send response headers, so the production build carries its
// security policy as meta tags. Build-only: the dev server needs inline HMR scripts.
function securityMeta(apiOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src ${apiOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  return {
    name: 'monolith-security-meta',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
      { tag: 'meta', attrs: { name: 'referrer', content: 'strict-origin-when-cross-origin' }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const apiOrigin = new URL(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL || 'https://api.mnlith.dev').origin;
  return {
    plugins: [react(), securityMeta(apiOrigin)],
    base: '/',
    build: { target: 'es2022', sourcemap: false },
  };
});
