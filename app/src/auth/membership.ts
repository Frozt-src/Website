// First login binds a Clerk user to an invited membership row. After that, authorization
// uses clerk_user_id alone and the email is never looked up in Clerk again.
import { recordAudit } from '../domain/audit.ts';
import type { ClerkUsers } from '../deps.ts';
import type { Client, Membership } from '../domain/models.ts';

export interface ResolvedMembership {
  membership: Membership;
  client: Client;
}

interface MembershipClientRow {
  m_id: string;
  m_client_id: string;
  m_email: string;
  m_clerk_user_id: string | null;
  m_role: string;
  m_status: string;
  m_bound_at: number | null;
  m_created_at: number;
  m_updated_at: number;
  c_id: string;
  c_name: string;
  c_billing_email: string;
  c_status: string;
  c_stripe_customer_id: string | null;
  c_external_source: string | null;
  c_external_id: string | null;
  c_created_at: number;
  c_updated_at: number;
}

// Columns are aliased because memberships and clients share several column names.
const activeMembershipQuery = `SELECT
    m.id AS m_id, m.client_id AS m_client_id, m.email AS m_email, m.clerk_user_id AS m_clerk_user_id,
    m.role AS m_role, m.status AS m_status, m.bound_at AS m_bound_at,
    m.created_at AS m_created_at, m.updated_at AS m_updated_at,
    c.id AS c_id, c.name AS c_name, c.billing_email AS c_billing_email, c.status AS c_status,
    c.stripe_customer_id AS c_stripe_customer_id, c.external_source AS c_external_source,
    c.external_id AS c_external_id, c.created_at AS c_created_at, c.updated_at AS c_updated_at
  FROM memberships m
  JOIN clients c ON c.id = m.client_id
  WHERE m.clerk_user_id = ? AND m.status = 'active'
  ORDER BY m.created_at
  LIMIT 1`;

function toResolved(row: MembershipClientRow): ResolvedMembership {
  return {
    membership: {
      id: row.m_id,
      clientId: row.m_client_id,
      email: row.m_email,
      clerkUserId: row.m_clerk_user_id,
      role: row.m_role as Membership['role'],
      status: row.m_status as Membership['status'],
      boundAt: row.m_bound_at,
      createdAt: row.m_created_at,
      updatedAt: row.m_updated_at,
    },
    client: {
      id: row.c_id,
      name: row.c_name,
      billingEmail: row.c_billing_email,
      status: row.c_status as Client['status'],
      stripeCustomerId: row.c_stripe_customer_id,
      externalSource: row.c_external_source,
      externalId: row.c_external_id,
      createdAt: row.c_created_at,
      updatedAt: row.c_updated_at,
    },
  };
}

async function findActiveMembership(db: D1Database, userId: string): Promise<ResolvedMembership | null> {
  const row = await db.prepare(activeMembershipQuery).bind(userId).first<MembershipClientRow>();
  return row ? toResolved(row) : null;
}

export async function resolveMembership(
  db: D1Database,
  deps: { clerkUsers: ClerkUsers; now(): number },
  userId: string,
): Promise<ResolvedMembership | null> {
  const bound = await findActiveMembership(db, userId);
  if (bound) return bound;

  const email = await deps.clerkUsers.primaryVerifiedEmail(userId);
  if (!email) return null;

  // The subquery picks a single invited row, so one login binds at most one membership.
  const at = deps.now();
  const update = await db
    .prepare(`UPDATE memberships SET clerk_user_id = ?, status = 'active', bound_at = ?, updated_at = ?
      WHERE id = (SELECT id FROM memberships
        WHERE lower(email) = lower(?) AND status = 'invited' AND clerk_user_id IS NULL
        ORDER BY created_at LIMIT 1)`)
    .bind(userId, at, at, email)
    .run();
  if (update.meta.changes === 0) return null;

  const resolved = await findActiveMembership(db, userId);
  if (!resolved) return null;

  await recordAudit(db, {
    occurredAt: at,
    actorType: 'client_user',
    actorId: userId,
    clientId: resolved.client.id,
    entityType: 'membership',
    entityId: resolved.membership.id,
    action: 'membership.bound',
    detailsJson: null,
  });
  return resolved;
}
