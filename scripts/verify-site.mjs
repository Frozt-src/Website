// Usage: npm run verify:site -- <base-url>   (default https://mnlith.dev/)
// Checks security headers, asset caching and not-found handling on the deployed site or `wrangler dev`.
const base = new URL(process.argv[2] ?? 'https://mnlith.dev/');
const expected = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src https://api.mnlith.dev; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};
const failures = [];
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`); if (!ok) failures.push(message); };
const get = path => fetch(new URL(path, base), { redirect: 'manual' });

const home = await get('/');
check(home.status === 200, `/ returns 200 (got ${home.status})`);
for (const [name, value] of Object.entries(expected)) check(home.headers.get(name) === value, `/ sends ${name}`);
const script = (await home.text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
check(Boolean(script), 'index.html references a hashed /assets/ script');
if (script) check((await get(script)).headers.get('cache-control') === 'public, max-age=31536000, immutable', `${script} is cached as immutable`);
const missing = await get('/this-page-does-not-exist');
check(missing.status === 404, `unknown path returns 404 (got ${missing.status})`);
check(missing.headers.get('content-security-policy') === expected['content-security-policy'], 'the 404 response carries the CSP');

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
