import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runEvidencePurge } from '../../src/seller/evidence-purge';
import { insertEvidence, listEvidenceForSeller, logDownload, findEvidence, recordScan, requestPurge, retireEvidence, usableEvidenceCount } from '../../src/seller/evidence-repo';
import { findAuthority } from '../../src/seller/authority-repo';
import { loadSellerPolicy, loadSellerPolicyDetail } from '../../src/seller/policy-load';
import { resetPolicy, writePolicy } from '../../src/seller/policy-repo';
import { anonymiseSeller, findPrivacySeller } from '../../src/seller/privacy-repo';
import { adminScope, convertedSeller, makeStaff, rid, ts, verifiedAuthority } from '../support/seller-db';

const db = env.DB;
const deleted: string[] = [];
const fakeEnv = { DB: db, PRIVATE_FILES: { delete: async (k: string) => void deleted.push(k) } } as never;

async function recordWithEvidence() {
  const owner = await makeStaff(db, 'broker');
  const admin = await makeStaff(db, 'admin');
  const other = await makeStaff(db, 'compliance');
  const ctx = await convertedSeller(db, owner);
  const reference = await verifiedAuthority(db, ctx, admin, other, 'AUTHORITY_TO_REPRESENT');
  const record = (await findAuthority(db, reference, adminScope))!;
  const add = async (scanStatus: 'pending' | 'clean' = 'pending') => {
    const evidenceId = rid();
    const ok = await insertEvidence(db, { id: owner, requestId: 'r', ts: ts(), evidenceId, recordId: record.id, recordReference: record.reference, sellerId: ctx.sellerId, sellerReference: ctx.reference, r2Key: `seller-evidence/${record.id}/${evidenceId}.pdf`, filename: 'mandate.pdf', contentType: 'application/pdf', byteSize: 1234, sha256: 'a'.repeat(64), scanStatus, scanProvider: null, scanSkipped: false, logId: rid(), auditId: rid() });
    return { evidenceId, ok };
  };
  return { owner, admin, other, ctx, record, add };
}
const scan = async (evidenceId: string, verdict: 'clean' | 'rejected', actor: string) => {
  const evidence = (await findEvidence(db, evidenceId, adminScope))!;
  return recordScan(db, { id: actor, requestId: 'r', ts: ts(), evidence, verdict, provider: 'test', reference: 'ref', skipped: false, scannedAt: ts(), logId: rid(), auditId: rid() });
};

describe('authority evidence (real D1)', () => {
  it('is unavailable until scanned clean, and a verdict is final', async () => {
    const s = await recordWithEvidence();
    const { evidenceId } = await s.add('pending');
    expect(await usableEvidenceCount(db, s.record.id)).toBe(0);
    expect(await scan(evidenceId, 'clean', s.other)).toBe(true);
    expect(await usableEvidenceCount(db, s.record.id)).toBe(1);
    expect(await scan(evidenceId, 'rejected', s.other)).toBe(false); // already scanned
    await expect(db.prepare("UPDATE seller_authority_evidence SET scan_status = 'rejected' WHERE id = ?").bind(evidenceId).run()).rejects.toThrow(/final/);
    await expect(db.prepare("UPDATE seller_authority_evidence SET sha256 = ? WHERE id = ?").bind('b'.repeat(64), evidenceId).run()).rejects.toThrow(/fixed/);
    await expect(db.prepare('DELETE FROM seller_authority_evidence WHERE id = ?').bind(evidenceId).run()).rejects.toThrow(/not deletable/);
    const upload = await db.prepare("SELECT details_json AS d FROM audit_logs WHERE action = 'authority.evidence_uploaded' AND entity_id = ?").bind(s.ctx.sellerId).first<{ d: string }>();
    expect(JSON.parse(upload!.d)).toMatchObject({ seller: s.ctx.reference, record: s.record.reference });
  });

  it('a rejected scan never counts as evidence', async () => {
    const s = await recordWithEvidence();
    const { evidenceId } = await s.add('pending');
    await scan(evidenceId, 'rejected', s.other);
    expect(await usableEvidenceCount(db, s.record.id)).toBe(0);
  });

  it('limits active files per record to 10', async () => {
    const s = await recordWithEvidence();
    for (let i = 0; i < 10; i++) expect((await s.add()).ok).toBe(true);
    expect((await s.add()).ok).toBe(false);
  });

  it('writes the access log for downloads and keeps it append-only', async () => {
    const s = await recordWithEvidence();
    const { evidenceId } = await s.add('pending');
    await scan(evidenceId, 'clean', s.other);
    const evidence = (await findEvidence(db, evidenceId, adminScope))!;
    await logDownload(db, { id: s.other, requestId: 'req-9', ts: ts(), evidence, logId: rid(), auditId: rid() });
    const rows = await db.prepare("SELECT action, actor_user_id AS a FROM seller_evidence_access_log WHERE evidence_id = ? ORDER BY created_at, id").bind(evidenceId).all<{ action: string; a: string | null }>();
    expect(rows.results?.map((r) => r.action)).toEqual(expect.arrayContaining(['uploaded', 'scanned', 'downloaded']));
    await expect(db.prepare("UPDATE seller_evidence_access_log SET action = 'purged' WHERE evidence_id = ?").bind(evidenceId).run()).rejects.toThrow(/append-only/);
    const audit = await db.prepare("SELECT details_json AS d FROM audit_logs WHERE action = 'authority.evidence_downloaded' AND entity_id = ?").bind(s.ctx.sellerId).first<{ d: string }>();
    expect(audit?.d).not.toMatch(/mandate\.pdf/); // file names are not copied into audit details
  });

  it('retire removes it from use; delete removes the bytes exactly once and redacts the name', async () => {
    const s = await recordWithEvidence();
    const { evidenceId } = await s.add('pending');
    await scan(evidenceId, 'clean', s.other);
    let evidence = (await findEvidence(db, evidenceId, adminScope))!;
    expect(await retireEvidence(db, { id: s.admin, requestId: 'r', ts: ts(), evidence, reason: 'Superseded', logId: rid(), auditId: rid() })).toBe(true);
    expect(await usableEvidenceCount(db, s.record.id)).toBe(0);
    expect(await requestPurge(db, { id: s.admin, requestId: 'r', ts: ts(), evidence, reason: 'Erasure request', logId: rid(), auditId: rid() })).toBe(true);
    expect(await requestPurge(db, { id: s.admin, requestId: 'r', ts: ts(), evidence, reason: 'again', logId: rid(), auditId: rid() })).toBe(false);
    const result = await runEvidencePurge(fakeEnv);
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain(`seller-evidence/${s.record.id}/${evidenceId}.pdf`);
    evidence = (await findEvidence(db, evidenceId, adminScope))!;
    expect(evidence).toMatchObject({ r2Key: null, filename: '[redacted]' });
    expect(evidence.purgedAt).not.toBeNull();
    const before = deleted.length;
    await runEvidencePurge(fakeEnv);
    expect(deleted.length).toBe(before); // idempotent
  });

  it('seller erasure marks evidence for purge and the purge removes it', async () => {
    const s = await recordWithEvidence();
    const { evidenceId } = await s.add('pending');
    await db.prepare("UPDATE seller_opportunity_links SET relationship_status = 'ENDED' WHERE id = ?").bind(s.ctx.linkId).run();
    await db.prepare("UPDATE seller_enquiries SET status = 'CLOSED' WHERE id = ?").bind(s.ctx.enquiryId).run();
    await db.prepare("UPDATE sellers SET status = 'INACTIVE' WHERE id = ?").bind(s.ctx.sellerId).run();
    const seller = (await findPrivacySeller(db, s.ctx.reference))!;
    expect(await anonymiseSeller(db, { id: s.admin, requestId: 'r', ts: ts(), seller, reason: 'Erasure request', auditId: rid() })).toBe(true);
    expect((await db.prepare('SELECT purge_pending AS p, filename FROM seller_authority_evidence WHERE id = ?').bind(evidenceId).first())).toEqual({ p: 1, filename: '[redacted]' });
    await runEvidencePurge(fakeEnv);
    expect((await db.prepare('SELECT r2_key AS k FROM seller_authority_evidence WHERE id = ?').bind(evidenceId).first())).toEqual({ k: null });
    expect((await listEvidenceForSeller(db, s.ctx.sellerId)).length).toBeGreaterThanOrEqual(1);
  });
});

describe('editable seller policy (real D1)', () => {
  it('stored values override the environment, invalid stored values are ignored, and reset restores the environment', async () => {
    const admin = await makeStaff(db, 'admin');
    const e = { ...env, SELLER_REMINDER_INTERVAL_HOURS: '12' } as never;
    expect((await loadSellerPolicy(e)).reminderIntervalHours).toBe(12);
    const write = (key: string, value: unknown, expectedVersion: number) => writePolicy(db, { id: admin, requestId: 'r', ts: ts(), key, value, expectedVersion, reason: 'test', auditId: rid(), auditDetails: { key } });
    expect(await write('reminder_interval_hours', 6, 0)).toBe(true);
    expect((await loadSellerPolicyDetail(e)).sources['reminder_interval_hours']).toBe('database');
    expect((await loadSellerPolicy(e)).reminderIntervalHours).toBe(6);
    expect(await write('reminder_interval_hours', 8, 0)).toBe(false); // stale: insert over an existing value
    expect(await write('reminder_interval_hours', 8, 5)).toBe(false); // wrong version
    expect(await write('reminder_interval_hours', 8, 1)).toBe(true);
    // A corrupt or out-of-range stored value must never be trusted.
    await db.prepare("INSERT INTO seller_policy_settings (setting_key, value_json, version, updated_at) VALUES ('escalation_after_hours', '99999', 1, ?)").bind(ts()).run();
    await db.prepare("INSERT INTO seller_policy_settings (setting_key, value_json, version, updated_at) VALUES ('separation_of_duties', '\"false\"', 1, ?)").bind(ts()).run();
    const policy = await loadSellerPolicy(e);
    expect(policy.escalationAfterHours).toBe(0);
    expect(policy.separationOfDuties).toBe(true); // a string "false" does not switch the safeguard off
    expect(await resetPolicy(db, { id: admin, requestId: 'r', ts: ts(), key: 'reminder_interval_hours', expectedVersion: 2, reason: 'back to env', auditId: rid(), auditDetails: { key: 'reminder_interval_hours' } })).toBe(true);
    expect((await loadSellerPolicy(e)).reminderIntervalHours).toBe(12);
    const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'seller_policy' AND entity_id = 'reminder_interval_hours'").first<{ n: number }>();
    expect(audits?.n).toBe(3);
  });

  it('is not readable through the platform settings table that editors can list', async () => {
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM platform_settings WHERE setting_key LIKE 'seller%' OR setting_key IN ('alert_recipients','escalation_recipients')").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
