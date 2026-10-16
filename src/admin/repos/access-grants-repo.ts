/** SQL for buyer access grants (data room access). */
export interface GrantRef {
  id: string;
  revokedAt: string | null;
  userId: string;
  opportunityId: string;
}

export async function listGrants(db: D1Database, nowIso: string): Promise<unknown[]> {
  const result = await db
    .prepare(
      'SELECT g.id, g.tier, g.granted_at AS grantedAt, g.expires_at AS expiresAt, g.revoked_at AS revokedAt, u.email AS buyerEmail, u.display_name AS buyerName, o.title AS opportunityTitle FROM access_grants g JOIN users u ON u.id = g.user_id JOIN opportunities o ON o.id = g.opportunity_id ORDER BY CASE WHEN g.revoked_at IS NULL AND g.expires_at > ? THEN 0 ELSE 1 END, g.granted_at DESC LIMIT 300',
    )
    .bind(nowIso)
    .all();
  return result.results ?? [];
}

export function findGrant(db: D1Database, id: string): Promise<GrantRef | null> {
  return db
    .prepare('SELECT id, revoked_at AS revokedAt, user_id AS userId, opportunity_id AS opportunityId FROM access_grants WHERE id = ?')
    .bind(id)
    .first<GrantRef>();
}

/** Revocation and its audit row commit together; the revoke only applies to a still-active grant. */
export async function revokeGrant(
  db: D1Database,
  a: { grant: GrantRef; staffId: string; requestId: string; reason: string; auditId: string; timestamp: string },
): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(a.timestamp, a.grant.id),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'access_grant.revoked', 'access_grant', ?, ?, ?, ?)",
      )
      .bind(
        a.auditId,
        a.staffId,
        a.grant.id,
        a.requestId,
        JSON.stringify({ reason: a.reason, userId: a.grant.userId, opportunityId: a.grant.opportunityId }),
        a.timestamp,
      ),
  ]);
}
