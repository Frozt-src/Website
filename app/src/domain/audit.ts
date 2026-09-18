import { newId } from './ids.ts';
import type { AuditEvent } from './models.ts';

// Prepared but not run, so callers can include it in a `db.batch([...])` alongside other writes.
export function auditStatement(db: D1Database, event: Omit<AuditEvent, 'id'>): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, client_id, entity_type, entity_id, action, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      newId(),
      event.occurredAt,
      event.actorType,
      event.actorId,
      event.clientId,
      event.entityType,
      event.entityId,
      event.action,
      event.detailsJson,
    );
}

export async function recordAudit(db: D1Database, event: Omit<AuditEvent, 'id'>): Promise<void> {
  await auditStatement(db, event).run();
}
