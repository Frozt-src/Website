import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';

const data = { name: 'Alex Doe', email: 'alex@example.com', company: 'Example', service: 'managed-it', message: 'We need help with our business systems.', consent: true, website: '' };
function request(body: unknown = data, origin: string | null = 'https://mnlith.dev', media = 'application/json; charset=utf-8') {
  const headers: Record<string, string> = { 'Content-Type': media, 'CF-Connecting-IP': '192.0.2.1' };
  if (origin) headers.Origin = origin;
  return new Request('https://api.mnlith.dev/inquiries', { method: 'POST', headers, body: JSON.stringify(body) });
}
test('cross-origin and originless submissions cannot reach storage', async () => {
  for (const origin of [null, 'https://evil.example', 'https://mnlith.dev.evil.example']) {
    assert.equal((await worker.fetch(request(data, origin), {})).status, 403);
  }
});
test('invalid consent, email, service and field sizes are rejected', async () => {
  for (const patch of [{consent: false}, {email: 'bad'}, {service:'unknown'}, {name:'x'.repeat(121)}, {message:'short'}, {website:'spam.example'}]) {
    assert.equal((await worker.fetch(request({...data, ...patch}), {})).status, 400);
  }
});
test('media type is exact, with charset parameters allowed', async () => {
  assert.equal((await worker.fetch(request(data, undefined, 'application/jsonp'), {})).status, 415);
  assert.equal((await worker.fetch(request(), {})).status, 503);
});
test('oversized bodies are refused', async () => {
  assert.equal((await worker.fetch(request({...data, message:'x'.repeat(17000)}), {})).status, 413);
});
test('no private data is exposed and health response has no bindings', async () => {
  assert.equal((await worker.fetch(new Request('https://api.mnlith.dev/inquiries'), {})).status, 405);
  const response = await worker.fetch(new Request('https://api.mnlith.dev/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {status:'ok'});
});
test('preflight only permits the defined request headers and trusted origin', async () => {
  const response = await worker.fetch(new Request('https://api.mnlith.dev/inquiries', {method:'OPTIONS', headers:{Origin:'https://mnlith.dev', 'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}}), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://mnlith.dev');
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});

// Real SQLite executes production SQL; the adapter replaces only the remote D1 transport.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_inquiries.sql', import.meta.url), 'utf8'));
  const DB = { prepare(query: string) { let values: any[] = []; return {
    bind(...input: any[]) { values = input; return this; },
    async first() { return sql.prepare(query).get(...values) ?? null; },
    async run() { const result = sql.prepare(query).run(...values); return {success:true, meta:{changes:Number(result.changes)}}; }
  }; } };
  return {sql, env:{DB, RATE_LIMIT_SECRET:'test-only-secret-that-is-at-least-32-characters'}};
}
test('201 follows durable insertion and returns the stored id', async () => {
  const {sql,env} = database();
  const result = await worker.fetch(request(), env as any);
  assert.equal(result.status,201);
  const {id} = await result.json() as {id:string};
  const row = sql.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
  assert.equal(row?.email,'alex@example.com');
  assert.equal(row?.message,data.message);
  assert.ok(Number(row?.consent_at) > 0);
  sql.close();
});
test('database insert failures never return success or leak internal SQL', async () => {
  const {sql,env} = database(); sql.exec('DROP TABLE inquiries');
  const result = await worker.fetch(request(),env as any);
  assert.equal(result.status,503);
  assert.ok(!(await result.text()).includes('SQL'));
  sql.close();
});
test('six concurrent submissions persist at most five records and never store a raw IP', async () => {
  const {sql,env} = database();
  const results = await Promise.all(Array.from({length:6},()=>worker.fetch(request(),env as any)));
  assert.equal(results.filter(x=>x.status===201).length,5);
  assert.equal(results.filter(x=>x.status===429).length,1);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM inquiries').get()?.n,5);
  const limit = sql.prepare('SELECT * FROM rate_limits').get();
  assert.match(String(limit?.key),/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(limit).includes('192.0.2.1'));
  sql.close();
});
test('an expired rate window allows a new submission', async () => {
  const {sql,env} = database();
  for(let i=0;i<5;i++) await worker.fetch(request(),env as any);
  sql.exec('UPDATE rate_limits SET window_start = 1');
  assert.equal((await worker.fetch(request(),env as any)).status,201);
  sql.close();
});
test('scheduled retention deletes old inquiries while preserving recent ones', async () => {
  const {sql,env} = database();
  await worker.fetch(request(),env as any);
  sql.exec('UPDATE inquiries SET created_at = 1');
  await worker.fetch(request(),env as any);
  await worker.scheduled({},env as any);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM inquiries').get()?.n,1);
  sql.close();
});

test('streamed bytes cannot bypass the limit without Content-Length', async () => {
  const body = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(9000)); controller.enqueue(new Uint8Array(9000)); controller.close(); }});
  const req = new Request('https://api.mnlith.dev/inquiries', {method:'POST',headers:{Origin:'https://mnlith.dev','Content-Type':'application/json'}, body, duplex:'half'} as any);
  assert.equal((await worker.fetch(req,{})).status,413);
});
test('malformed JSON is rejected and missing edge IP fails closed', async () => {
  const malformed = new Request('https://api.mnlith.dev/inquiries',{method:'POST',headers:{Origin:'https://mnlith.dev','Content-Type':'application/json'},body:'{'});
  assert.equal((await worker.fetch(malformed,{})).status,400);
  const {sql,env} = database();
  const req = request(); req.headers.delete('CF-Connecting-IP');
  assert.equal((await worker.fetch(req,env as any)).status,503);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM inquiries').get()?.n,0);
  sql.close();
});
test('preflight cannot grant arbitrary headers or methods', async () => {
  for (const headers of [{'Access-Control-Request-Method':'DELETE'}, {'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'}]) {
    const req = new Request('https://api.mnlith.dev/inquiries',{method:'OPTIONS', headers:{Origin:'https://mnlith.dev',...headers}});
    assert.equal((await worker.fetch(req,{})).status,403);
  }
});
test('www origin and API alias save with correct CORS response', async () => {
  const {sql,env} = database();
  const req = new Request('https://api.mnlith.dev/api/inquiries',request(data,'https://www.mnlith.dev'));
  const result = await worker.fetch(req,env as any);
  assert.equal(result.status,201);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),'https://www.mnlith.dev');
  sql.close();
});
