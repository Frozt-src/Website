// Reads and writes the local D1 the running Worker is using (app/.wrangler/state), through
// `wrangler d1 execute --local --json`. Same transport the seed script uses, so the integration
// tests never need a second copy of the schema. Local only: there is no --remote path here.
import { execSync } from 'node:child_process';
import { repoRoot } from './env.ts';

const databaseName = 'monolith-app-staging';
const wranglerConfig = 'app/wrangler.jsonc';

// execSync always runs through a shell, so array args are not auto-quoted for us; only the SQL
// text can contain whitespace here.
function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function d1<T>(sql: string): T[] {
  const args = ['wrangler', 'd1', 'execute', databaseName, '--local', '--config', wranglerConfig, '--env', 'dev', '--json', '--command', sql];
  const stdout = execSync(`npx ${args.map(quoteArg).join(' ')}`, { cwd: repoRoot, encoding: 'utf8' });
  return (JSON.parse(stdout.trim()) as { results: T[] }[])[0].results;
}

export interface WaitOptions<T> {
  // Named in the timeout message, so a run that never gets its webhook says what it was waiting for.
  label: string;
  timeoutMs: number;
  intervalMs?: number;
  // Returns null while the condition has not been met yet.
  probe(): T | null;
}

export async function waitFor<T>(options: WaitOptions<T>): Promise<T> {
  const intervalMs = options.intervalMs ?? 3000;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const result = options.probe();
    if (result !== null) return result;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for ${options.label}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
