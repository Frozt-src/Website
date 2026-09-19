// Security headers applied to every response, by host.
const payCsp = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";
const hsts = 'max-age=31536000; includeSubDomains';

export function payHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': payCsp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    // The url is the authorisation on this host, so no pay page may ever be indexed.
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': hsts,
  };
}

export function portalHeaders(clerkFrontendApiUrl: string): Record<string, string> {
  const clerkSource = clerkFrontendApiUrl ? ` ${clerkFrontendApiUrl}` : '';
  const directives = [
    "default-src 'self'",
    `script-src 'self'${clerkSource}`,
    `connect-src 'self'${clerkSource}`,
    "img-src 'self' https://img.clerk.com",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    ...(clerkFrontendApiUrl ? ['frame-src https://challenges.cloudflare.com'] : []),
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ];
  return {
    'Content-Security-Policy': directives.join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': hsts,
  };
}
