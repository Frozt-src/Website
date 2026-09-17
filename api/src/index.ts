export interface Env { DB?: D1Database; RATE_LIMIT_SECRET?: string }
const origins = new Set(['https://mnlith.dev', 'https://www.mnlith.dev']);
const services = new Set(['managed-it', 'security', 'cloud', 'automation', 'not-sure']);
const maxBytes = 16_384;
function response(status: number, body: unknown, origin: string | null, extra: Record<string,string> = {}) {
  const headers: Record<string,string> = { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', Vary:'Origin', ...extra };
  if (origin && origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}
class InputError extends Error { status: number; constructor(status: number) { super(); this.status = status; } }
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new InputError(413);
  if (!request.body) throw new InputError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new InputError(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true, ignoreBOM:false}).decode(bytes)); } catch { throw new InputError(400); }
}
function validate(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError(400);
  const data = body as Record<string, unknown>;
  const text = (key: string, min: number, max: number) => {
    const value = data[key];
    if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new InputError(400);
    return value.trim();
  };
  const name = text('name', 1, 120), email = text('email', 3, 254), company = text('company', 1, 160), service = text('service', 1, 40), message = text('message', 10, 5000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !services.has(service) || data.consent !== true || (data.website !== undefined && data.website !== '')) throw new InputError(400);
  const teamSize = data.teamSize === undefined ? '' : text('teamSize', 0, 40);
  return {name, email, company, service, teamSize, message};
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin'), path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return response(200, {status:'ok'}, origin);
    if (path !== '/inquiries' && path !== '/api/inquiries') return response(404, {error:'Not found.'}, origin);
    if (request.method !== 'POST' && request.method !== 'OPTIONS') return response(405, {error:'Method not allowed.'}, origin, {Allow:'POST, OPTIONS'});
    if (!origin || !origins.has(origin)) return response(403, {error:'Origin not allowed.'}, null);
    if (request.method === 'OPTIONS') {
      const requested = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
      if (request.headers.get('Access-Control-Request-Method') !== 'POST' || requested.some(x=>x !== 'content-type')) return response(403, {error:'Preflight not allowed.'}, origin);
      return response(204, null, origin, {'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Max-Age':'600'});
    }
    if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return response(415, {error:'Send application/json.'}, origin);
    try {
      const data = validate(await readBody(request));
      const ip = request.headers.get('CF-Connecting-IP');
      if (!env.DB || !env.RATE_LIMIT_SECRET || env.RATE_LIMIT_SECRET.length < 32 || !ip) return response(503, {error:'Inquiry service is temporarily unavailable. Please try again later.'}, origin);
      const encoder = new TextEncoder();
      const secret = await crypto.subtle.importKey('raw', encoder.encode(env.RATE_LIMIT_SECRET), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
      const digest = await crypto.subtle.sign('HMAC', secret, encoder.encode(ip));
      const key = Array.from(new Uint8Array(digest), x=>x.toString(16).padStart(2,'0')).join('');
      const now = Math.floor(Date.now()/1000);
      // A single atomic SQLite UPSERT owns the quota decision, including concurrent requests.
      // Window starts on the first accepted attempt and resets after an hour.
      const quota = await env.DB.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
          window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
        WHERE rate_limits.window_start <= ? OR rate_limits.count < 5
        RETURNING count`).bind(key, now, now-3600, now-3600, now-3600).first<{count:number}>();
      if (!quota) return response(429, {error:'Too many inquiries. Please try again in an hour.'}, origin, {'Retry-After':'3600'});
      const id = crypto.randomUUID();
      const stored = await env.DB.prepare(`INSERT INTO inquiries (id, created_at, name, email, company, service, team_size, message, consent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, now, data.name, data.email, data.company, data.service, data.teamSize, data.message, now).run();
      if (!stored.success || stored.meta.changes !== 1) throw new Error('Storage unavailable');
      return response(201, {id, status:'saved'}, origin);
    } catch (error) {
      return response(error instanceof InputError ? error.status : 503, {error:error instanceof InputError ? 'Please check your inquiry details.' : 'Inquiry service is temporarily unavailable.'}, origin);
    }
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (!env.DB) throw new Error('Database binding missing');
    const now = Math.floor(Date.now()/1000);
    await env.DB.prepare('DELETE FROM inquiries WHERE created_at < ?').bind(now - 90*86400).run();
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run();
  },
};
