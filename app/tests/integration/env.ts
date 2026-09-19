// Preconditions for the gated integration tests, decided once at import time: the test-mode keys
// in app/.dev.vars and a Worker answering on 127.0.0.1:8788. When anything is missing, `skip`
// carries the reason and every test reports it instead of failing.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
// URL comes from node:url so it is not the workers-types global of the same name.
import { fileURLToPath, URL } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// `wrangler dev --env dev` serves both hosts on one port; the hostname it routes on comes from the
// request's Host header. Node's fetch() refuses to send that header, so these use node:http.
const workerHost = '127.0.0.1';
const workerPort = 8788;
const payHost = 'pay.localhost';
const portalHost = 'localhost';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface Harness {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  clerkSecretKey: string;
  manual: boolean;
  // Redirects are never followed, so a 303 to Stripe is observable as itself.
  pay(path: string, init?: HttpInit): Promise<HttpResponse>;
  portal(path: string, init?: HttpInit): Promise<HttpResponse>;
}

function httpRequest(host: string, path: string, init: HttpInit = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: workerHost,
        port: workerPort,
        path,
        method: init.method ?? 'GET',
        // The port belongs in the Host header: wrangler routes on the hostname alone, but the
        // Worker builds its absolute urls from the request url, so a Host without it would give
        // Stripe a success_url of http://pay.localhost/… that nothing serves.
        headers: { Host: `${host}:${workerPort}`, ...init.headers },
      },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (body += chunk));
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
          }
          resolve({ status: response.statusCode ?? 0, headers, body });
        });
      },
    );
    outgoing.on('error', reject);
    if (init.body !== undefined) outgoing.write(init.body);
    outgoing.end();
  });
}

// KEY=value, one per line, `#` comments and surrounding quotes ignored — the same subset of
// dotenv syntax wrangler itself reads out of .dev.vars.
function readDevVars(): Record<string, string> | null {
  let contents: string;
  try {
    contents = readFileSync(join(repoRoot, 'app/.dev.vars'), 'utf8');
  } catch {
    return null;
  }
  const vars: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    vars[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

function missingKey(vars: Record<string, string>, key: string, prefix: string): string | null {
  const value = vars[key];
  if (!value || value.endsWith('replace_me')) return `app/.dev.vars has no real ${key} (still the .dev.vars.example placeholder)`;
  if (!value.startsWith(prefix)) return `app/.dev.vars ${key} does not start with ${prefix} — integration tests never run against live credentials`;
  return null;
}

async function workerUnreachable(): Promise<string | null> {
  try {
    const response = await httpRequest(payHost, '/healthz');
    if (response.status !== 200) return `http://${workerHost}:${workerPort}/healthz answered ${response.status}, expected 200`;
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return `no Worker on http://${workerHost}:${workerPort} (${reason}) — run \`npm run app:dev\``;
  }
}

async function reasonToSkip(vars: Record<string, string> | null): Promise<string | null> {
  if (!vars) return 'app/.dev.vars not found — copy app/.dev.vars.example and fill in test-mode keys';
  return (
    missingKey(vars, 'STRIPE_SECRET_KEY', 'sk_test_') ??
    missingKey(vars, 'STRIPE_WEBHOOK_SECRET', 'whsec_') ??
    missingKey(vars, 'CLERK_SECRET_KEY', 'sk_test_') ??
    (await workerUnreachable())
  );
}

const devVars = readDevVars();
const reason = await reasonToSkip(devVars);

export const skip: string | false = reason ?? false;
// The card and bank pages are completed by a person, so those tests stay out of an unattended run.
export const manualSkip: string | false =
  skip || (process.env.MONOLITH_INTEGRATION_MANUAL === '1' ? false : 'manual step — set MONOLITH_INTEGRATION_MANUAL=1 to run it');

export const harness: Harness = {
  stripeSecretKey: devVars?.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: devVars?.STRIPE_WEBHOOK_SECRET ?? '',
  clerkSecretKey: devVars?.CLERK_SECRET_KEY ?? '',
  manual: process.env.MONOLITH_INTEGRATION_MANUAL === '1',
  pay: (path, init) => httpRequest(payHost, path, init),
  portal: (path, init) => httpRequest(portalHost, path, init),
};
