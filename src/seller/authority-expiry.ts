/** Scheduled sweep: verified authority/mandate records past their validity window become EXPIRED, withdrawing dependent live listings. */
import type { Env } from '../env';
import { purgeOpportunityPublicCache } from '../admin/shared';
import { changeAuthority, listExpiredVerified, opportunityForLink } from './authority-repo';

export async function runAuthorityExpiry(env: Env, nowIso = new Date().toISOString()): Promise<{ expired: number; withdrawn: number }> {
  let expired = 0;
  let withdrawn = 0;
  for (const record of await listExpiredVerified(env.DB, nowIso, 100)) {
    const before = await opportunityForLink(env.DB, record.linkId);
    const ok = await changeAuthority(env.DB, {
      id: '', requestId: 'scheduled-authority-expiry', ts: nowIso, record, to: 'EXPIRED', note: 'Validity period ended.', reviewerId: null, eventId: crypto.randomUUID(), auditId: crypto.randomUUID(),
      withdrawAuditAction: 'authority.expired_withdrew_listing', evidenceType: null, evidenceRef: null, scope: null, limitations: null, validFrom: null, validUntil: null,
    });
    if (!ok) continue;
    expired++;
    if (before?.live && !(await opportunityForLink(env.DB, record.linkId))?.live) {
      withdrawn++;
      await purgeOpportunityPublicCache(env, before.slug, before.country);
    }
  }
  return { expired, withdrawn };
}
