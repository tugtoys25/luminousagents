import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  attachSignedPdf, detachSignedPdf, findAccessibleDocument, findActiveGrant, findActiveTemplate, findBuyerProfile,
  findBuyerSession, findPendingNdaForUpload, findPublicOpportunityIdBySlug, findTemplateForAcknowledgement,
  hasOpenNdaRequest, insertBuyerAudit, insertNdaRequest, listBuyerActivity, listDocumentsAtTier, listNdaRequests,
  listSavedPublic, publicOpportunityExists, recordSignedPdfUpload, saveOpportunity, unsaveOpportunity, upsertBuyerProfile,
} from '../../src/buyers/buyers-repo';

// These steps share database state and must run in order. The Workers test pool undoes storage after
// every test, so they run as steps inside one test instead of as separate `it` blocks.
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

const t0 = '2026-10-05T10:00:00.000Z';
const t1 = '2026-10-05T12:00:00.000Z';
const past = '2020-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';
const n = async (sql: string, ...a: string[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const buyer = (id: string, status = 'active', mustChange = 0) =>
  run("INSERT INTO users (id, email, display_name, role, user_type, status, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 'buyer', 'buyer', ?, 'h', ?, ?, ?)", id, `${id}@example.com`, id, status, mustChange, t0, t0);
const opp = (id: string, over: { vis?: number; review?: string; cls?: string; life?: string } = {}) =>
  run('INSERT INTO opportunities (id, slug, title, country, opportunity_type, classification, lifecycle, content_review_status, public_visibility, price_visibility, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)',
    id, `bs-${id}`, `Opp ${id}`, 'Malta', 'casino', over.cls ?? 'public', over.life ?? 'published', over.review ?? 'approved', over.vis ?? 1, t0, t0, t0);
const grant = (id: string, user: string, oppId: string, ndaId: string, tier: number, exp = future, revoked: string | null = null) =>
  run('INSERT INTO access_grants (id, user_id, opportunity_id, nda_request_id, tier, granted_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?)', id, user, oppId, ndaId, tier, t0, exp, revoked);
const ndaRow = (id: string, user: string, oppId: string, status = 'pending') =>
  run("INSERT INTO nda_requests (id, user_id, opportunity_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)", id, user, oppId, status, t0, t0);
const doc = (id: string, oppId: string, tier: number, scan: string) =>
  run("INSERT INTO documents (id, opportunity_id, r2_key, filename, content_type, byte_size, tier, scan_status, created_at) VALUES (?,?,?,?,'application/pdf',5,?,?,?)", id, oppId, `bk/${id}`, `${id}.pdf`, tier, scan, t0);
const session = (id: string, user: string, hash: string, exp = future, revoked: string | null = null) =>
  run("INSERT INTO sessions (id, user_id, token_hash, session_type, expires_at, revoked_at, created_at, last_seen_at) VALUES (?,?,?,'buyer',?,?,?,?)", id, user, hash, exp, revoked, t0, t0);

describe('buyer session', () => {
  it('runs its steps in order', async () => {
    await step('buyer session > resolves only live sessions of active buyers', async () => {
      await buyer('b1'); await buyer('b2', 'suspended'); await buyer('b3', 'active', 1);
      await session('bs1', 'b1', 'bh-ok'); await session('bs2', 'b1', 'bh-exp', past); await session('bs3', 'b1', 'bh-rev', future, t0);
      await session('bs4', 'b2', 'bh-susp'); await session('bs5', 'b3', 'bh-must');
      expect(await findBuyerSession(env.DB, 'bh-ok', t1)).toMatchObject({ id: 'b1', sessionId: 'bs1', hasPassword: 1, mustChange: 0 });
      for (const bad of ['bh-exp', 'bh-rev', 'bh-susp', 'nope']) expect(await findBuyerSession(env.DB, bad, t1)).toBeNull();
      expect(await findBuyerSession(env.DB, 'bh-must', t1)).toMatchObject({ mustChange: 1 }); // the route then refuses with PASSWORD_CHANGE_REQUIRED
    });

    await step('buyer profile > upserts and reads back, replacing on conflict', async () => {
      expect(await findBuyerProfile(env.DB, 'b1')).toBeNull();
      const base = { userId: 'b1', companyName: 'Acme', roleTitle: 'CEO', countriesJson: '["Malta"]', budgetMinMinor: 100, budgetMaxMinor: 900, currency: 'EUR', experienceNotes: 'x', timestamp: t0 };
      await upsertBuyerProfile(env.DB, base);
      await upsertBuyerProfile(env.DB, { ...base, companyName: 'Acme2', budgetMinMinor: null, timestamp: t1 });
      expect(await findBuyerProfile(env.DB, 'b1')).toMatchObject({ companyName: 'Acme2', budgetMinMinor: null, budgetMaxMinor: 900, currency: 'EUR', updatedAt: t1 });
      expect(await n("SELECT COUNT(*) AS n FROM buyer_profiles WHERE user_id = 'b1'")).toBe(1);
    });

    await step('saved listings > only publicly listed opportunities can be saved, and a listing that goes private leaves the buyer list', async () => {
      await opp('o1'); await opp('o-draft', { life: 'draft' }); await opp('o-hidden', { vis: 0 }); await opp('o-conf', { cls: 'confidential' }); await opp('o-pend', { review: 'pending' });
      expect(await publicOpportunityExists(env.DB, 'o1')).toBe(true);
      for (const id of ['o-draft', 'o-hidden', 'o-conf', 'o-pend', 'nope']) expect(await publicOpportunityExists(env.DB, id)).toBe(false);
      await saveOpportunity(env.DB, 'b1', 'o1', t0);
      await saveOpportunity(env.DB, 'b1', 'o1', t1); // idempotent
      expect(await n("SELECT COUNT(*) AS n FROM saved_opportunities WHERE user_id='b1'")).toBe(1);
      expect((await listSavedPublic(env.DB, 'b1')).map((r) => r.id)).toEqual(['o1']);
      await run('UPDATE opportunities SET public_visibility = 0 WHERE id = ?', 'o1');
      expect(await listSavedPublic(env.DB, 'b1')).toEqual([]);
      await run('UPDATE opportunities SET public_visibility = 1 WHERE id = ?', 'o1');
      await buyer('b9'); expect(await listSavedPublic(env.DB, 'b9')).toEqual([]); // other buyers see nothing
      await unsaveOpportunity(env.DB, 'b1', 'o1');
      expect(await listSavedPublic(env.DB, 'b1')).toEqual([]);
    });

    await step('data-room access rules > a grant counts only while unrevoked AND unexpired, and only for its own buyer and listing', async () => {
      await ndaRow('n-a', 'b1', 'o1', 'approved'); await ndaRow('n-b', 'b1', 'o-draft', 'approved'); await ndaRow('n-c', 'b1', 'o-hidden', 'approved');
      await grant('g-live', 'b1', 'o1', 'n-a', 2);
      expect(await findActiveGrant(env.DB, 'b1', 'o1', t1)).toMatchObject({ id: 'g-live', tier: 2 });
      expect(await findActiveGrant(env.DB, 'b9', 'o1', t1)).toBeNull();           // someone else's grant
      expect(await findActiveGrant(env.DB, 'b1', 'o-hidden', t1)).toBeNull();     // other listing
      await grant('g-exp', 'b1', 'o-draft', 'n-b', 2, past);
      expect(await findActiveGrant(env.DB, 'b1', 'o-draft', t1)).toBeNull();      // expired
      await grant('g-rev', 'b1', 'o-hidden', 'n-c', 2, future, t0);
      expect(await findActiveGrant(env.DB, 'b1', 'o-hidden', t1)).toBeNull();     // revoked
      expect(await findActiveGrant(env.DB, 'b1', 'o1', '2100-01-01T00:00:00.000Z')).toBeNull(); // time passes
    });

    await step('data-room access rules > documents are listed only when clean AND at or below the grant tier', async () => {
      await doc('d-t1', 'o1', 1, 'clean'); await doc('d-t2', 'o1', 2, 'clean'); await doc('d-t3', 'o1', 3, 'clean');
      await doc('d-pend', 'o1', 1, 'pending'); await doc('d-rej', 'o1', 1, 'rejected');
      expect((await listDocumentsAtTier(env.DB, 'o1', 1)).map((d) => d['id'])).toEqual(['d-t1']);
      expect((await listDocumentsAtTier(env.DB, 'o1', 2)).map((d) => d['id']).sort()).toEqual(['d-t1', 'd-t2']);
      expect((await listDocumentsAtTier(env.DB, 'o1', 0))).toEqual([]);
    });

    await step('data-room access rules > a document is reachable only if clean AND its listing is public; the tier is returned so the caller can compare', async () => {
      expect(await findAccessibleDocument(env.DB, 'd-t2')).toMatchObject({ id: 'd-t2', opportunityId: 'o1', tier: 2, r2Key: 'bk/d-t2' });
      expect(await findAccessibleDocument(env.DB, 'd-pend')).toBeNull();
      expect(await findAccessibleDocument(env.DB, 'd-rej')).toBeNull();
      await doc('d-hid', 'o-hidden', 1, 'clean');
      expect(await findAccessibleDocument(env.DB, 'd-hid')).toBeNull();           // listing not public
      await doc('d-conf', 'o-conf', 1, 'clean');
      expect(await findAccessibleDocument(env.DB, 'd-conf')).toBeNull();
      expect(await findAccessibleDocument(env.DB, 'nope')).toBeNull();
      await run("UPDATE opportunities SET public_visibility = 0 WHERE id = 'o1'");
      expect(await findAccessibleDocument(env.DB, 'd-t2')).toBeNull();            // un-publishing pulls the data room offline too
      await run("UPDATE opportunities SET public_visibility = 1 WHERE id = 'o1'");
    });

    await step('NDA templates and requests > uses the latest ACTIVE template; a named template must still be active', async () => {
      expect(await findActiveTemplate(env.DB)).toBeNull();
      const t = (id: string, v: number, st: string) => run('INSERT INTO nda_templates (id, name, version, content_hash, status, created_at) VALUES (?,?,?,?,?,?)', id, 'NDA', v, `hash${v}`, st, t0);
      await t('nt1', 1, 'active'); await t('nt2', 2, 'active'); await t('nt3', 3, 'draft'); await t('nt4', 4, 'retired');
      expect(await findActiveTemplate(env.DB)).toMatchObject({ id: 'nt2', version: 2, contentHash: 'hash2' });
      expect((await findTemplateForAcknowledgement(env.DB, undefined))?.id).toBe('nt2');
      expect((await findTemplateForAcknowledgement(env.DB, 'nt1'))?.id).toBe('nt1');
      expect(await findTemplateForAcknowledgement(env.DB, 'nt3')).toBeNull();
      expect(await findTemplateForAcknowledgement(env.DB, 'nt4')).toBeNull();
    });

    await step('NDA templates and requests > finds a public listing by slug only', async () => {
      expect(await findPublicOpportunityIdBySlug(env.DB, 'bs-o1')).toBe('o1');
      expect(await findPublicOpportunityIdBySlug(env.DB, 'bs-o-hidden')).toBeNull();
      expect(await findPublicOpportunityIdBySlug(env.DB, 'bs-o-conf')).toBeNull();
    });

    await step('NDA templates and requests > creates the request, its audit row and the review job atomically, and blocks duplicates', async () => {
      expect(await hasOpenNdaRequest(env.DB, 'b9', 'o1', t1)).toBe(false);
      const r = { requestId: 'nr-1', userId: 'b9', opportunityId: 'o1', templateId: 'nt2', acceptanceName: 'Jane Roe', acceptedIpHash: 'iph', templateHash: 'hash2', timestamp: t0, auditId: 'na-1', auditRequestId: 'rq', jobId: 'nj-1' };
      await insertNdaRequest(env.DB, r);
      expect(await env.DB.prepare("SELECT status, acceptance_name AS a, nda_template_hash AS h, accepted_ip_hash AS ip FROM nda_requests WHERE id='nr-1'").first()).toMatchObject({ status: 'pending', a: 'Jane Roe', h: 'hash2', ip: 'iph' });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id='na-1' AND action='nda.requested' AND actor_type='buyer'")).toBe(1);
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE id='nj-1' AND job_type='nda.review_requested'")).toBe(1);
      expect(await hasOpenNdaRequest(env.DB, 'b9', 'o1', t1)).toBe(true); // pending blocks
      await run("UPDATE nda_requests SET status='rejected' WHERE id='nr-1'");
      expect(await hasOpenNdaRequest(env.DB, 'b9', 'o1', t1)).toBe(false); // rejected does not
      await run("UPDATE nda_requests SET status='approved' WHERE id='nr-1'");
      expect(await hasOpenNdaRequest(env.DB, 'b9', 'o1', t1)).toBe(false); // approved without a grant does not
      await grant('g-nr1', 'b9', 'o1', 'nr-1', 1);
      expect(await hasOpenNdaRequest(env.DB, 'b9', 'o1', t1)).toBe(true);  // approved with a live grant does
      expect(await hasOpenNdaRequest(env.DB, 'b9', 'o1', '2100-01-01T00:00:00.000Z')).toBe(false); // grant expired
    });

    await step('NDA templates and requests > rolls the request back if the job cannot be queued', async () => {
      await expect(insertNdaRequest(env.DB, { requestId: 'nr-2', userId: 'b9', opportunityId: 'o1', templateId: 'nt2', acceptanceName: 'X Y', acceptedIpHash: 'i', templateHash: 'h', timestamp: t0, auditId: 'na-2', auditRequestId: 'rq', jobId: 'nj-1' })).rejects.toThrow();
      expect(await n("SELECT COUNT(*) AS n FROM nda_requests WHERE id='nr-2'")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id='na-2'")).toBe(0);
    });

    await step('NDA templates and requests > lists a buyer\'s own requests only, with grant details', async () => {
      const mine = await listNdaRequests(env.DB, 'b9');
      expect(mine.map((r) => r['id'])).toEqual(['nr-1']);
      expect(mine[0]).toMatchObject({ opportunityId: 'o1', grantId: 'g-nr1', accessTier: 1 });
      expect((await listNdaRequests(env.DB, 'b1')).every((r) => r['id'] !== 'nr-1')).toBe(true);
    });

    await step('signed NDA PDF upload > only the owner of a PENDING request can start an upload', async () => {
      await ndaRow('sp-1', 'b1', 'o1', 'pending'); await ndaRow('sp-2', 'b1', 'o-draft', 'approved');
      expect(await findPendingNdaForUpload(env.DB, 'sp-1', 'b1')).toMatchObject({ id: 'sp-1', signedPdfR2Key: null });
      expect(await findPendingNdaForUpload(env.DB, 'sp-1', 'b9')).toBeNull();   // not the owner
      expect(await findPendingNdaForUpload(env.DB, 'sp-2', 'b1')).toBeNull();   // not pending
      expect(await findPendingNdaForUpload(env.DB, 'nope', 'b1')).toBeNull();
    });

    await step('signed NDA PDF upload > attach is compare-and-set: succeeds once, then refuses a second file, a wrong owner, or a non-pending request', async () => {
      const p = { key: 'nda-signed/sp-1/a.pdf', sha256: 'sha', provider: 'prov', scannedAt: t0, timestamp: t1, requestId: 'sp-1', userId: 'b1' };
      expect(await attachSignedPdf(env.DB, { ...p, userId: 'b9' })).toBe(false);
      expect(await attachSignedPdf(env.DB, { ...p, requestId: 'sp-2' })).toBe(false);
      expect(await attachSignedPdf(env.DB, p)).toBe(true);
      expect(await attachSignedPdf(env.DB, { ...p, key: 'nda-signed/sp-1/b.pdf' })).toBe(false); // already has one
      expect((await findPendingNdaForUpload(env.DB, 'sp-1', 'b1'))?.signedPdfR2Key).toBe('nda-signed/sp-1/a.pdf');
      expect(await env.DB.prepare("SELECT signed_pdf_sha256 AS s, signed_pdf_scan_provider AS p FROM nda_requests WHERE id='sp-1'").first()).toMatchObject({ s: 'sha', p: 'prov' });
    });

    await step('signed NDA PDF upload > records audit + notification atomically; detach only clears the exact key it set', async () => {
      await recordSignedPdfUpload(env.DB, { auditId: 'pa-1', userId: 'b1', requestId: 'sp-1', auditRequestId: 'rq', detailsJson: '{}', timestamp: t1, jobId: 'pj-1' });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id='pa-1' AND action='nda.signed_pdf_uploaded'")).toBe(1);
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE id='pj-1' AND job_type='nda.signed_pdf_uploaded'")).toBe(1);
      await expect(recordSignedPdfUpload(env.DB, { auditId: 'pa-2', userId: 'b1', requestId: 'sp-1', auditRequestId: 'rq', detailsJson: '{}', timestamp: t1, jobId: 'pj-1' })).rejects.toThrow();
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id='pa-2'")).toBe(0);
      await detachSignedPdf(env.DB, 'sp-1', 'some-other-key', t1);
      expect((await findPendingNdaForUpload(env.DB, 'sp-1', 'b1'))?.signedPdfR2Key).toBe('nda-signed/sp-1/a.pdf'); // untouched
      await detachSignedPdf(env.DB, 'sp-1', 'nda-signed/sp-1/a.pdf', t1);
      expect((await findPendingNdaForUpload(env.DB, 'sp-1', 'b1'))?.signedPdfR2Key).toBeNull();
    });

    await step('buyer audit and activity > writes buyer-typed audit rows and summarises the latest download/preview per document', async () => {
      const a = (id: string, action: string, entity: string, ts: string, user = 'b1') =>
        insertBuyerAudit(env.DB, { id, buyerId: user, action, entityType: 'document', entityId: entity, requestId: 'rq', detailsJson: '{}', timestamp: ts });
      await a('ac1', 'document.downloaded', 'd-t1', t0); await a('ac2', 'document.downloaded', 'd-t1', t1);
      await a('ac3', 'document.previewed', 'd-t1', t0); await a('ac4', 'nda.template_downloaded', 'nt2', t0);
      await a('ac5', 'document.downloaded', 'd-t2', t0, 'b9'); await a('ac6', 'something.else', 'x', t0);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id='ac1' AND actor_type='buyer'")).toBe(1);
      const act = await listBuyerActivity(env.DB, 'b1');
      expect(act.find((r) => r.action === 'document.downloaded' && r.entityId === 'd-t1')?.at).toBe(t1); // MAX, not first
      expect(act.some((r) => r.entityId === 'd-t2')).toBe(false);   // another buyer's activity is invisible
      expect(act.some((r) => r.action === 'something.else')).toBe(false); // unrelated actions excluded
      expect(act.length).toBe(3);
    });
  });
});












