// Gate for the portal API: a valid Clerk session plus an active membership, or nothing.
import type { MiddlewareHandler } from 'hono';
import type { AppDeps } from '../deps.ts';
import type { Client, Membership } from '../domain/models.ts';
import { resolveMembership } from './membership.ts';

export interface AuthContext {
  userId: string;
  membership: Membership;
  client: Client;
}

export interface AuthEnv {
  Variables: { auth: AuthContext };
}

const bearerPrefix = 'Bearer ';

export function requireClient(deps: AppDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    if (!header.startsWith(bearerPrefix)) return c.json({ error: 'unauthenticated' }, 401);

    const session = await deps.sessions.verify(header.slice(bearerPrefix.length).trim());
    if (!session) return c.json({ error: 'unauthenticated' }, 401);

    const resolved = await resolveMembership(deps.db, deps, session.userId);
    if (!resolved) return c.json({ error: 'no_account' }, 403);

    c.set('auth', { userId: session.userId, membership: resolved.membership, client: resolved.client });
    await next();
  };
}
