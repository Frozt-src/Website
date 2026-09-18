import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Cloudflare serves dist/_headers with every static asset response. The build owns the file
// so the CSP's connect-src always matches the API origin compiled into the bundle.
function securityHeaders(apiOrigin: string): Plugin {
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
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  const headers = [
    '/*',
    `  Content-Security-Policy: ${policy}`,
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
  return {
    name: 'monolith-security-headers',
    apply: 'build',
    generateBundle() { this.emitFile({ type: 'asset', fileName: '_headers', source: headers }); },
  };
}

export default defineConfig(({ mode }) => {
  const apiOrigin = new URL(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL || 'https://api.mnlith.dev').origin;
  return {
    plugins: [react(), securityHeaders(apiOrigin)],
    base: '/',
    build: { target: 'es2022', sourcemap: false },
  };
});
