import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  deleteDocumentRow, findDocumentForDelete, findDocumentForReview, findDocumentForScan, insertDocumentWithAudit,
  loadSavedScan, recordScanResult, setScanStatusManually, type ScanRecord,
} from '../../src/admin/repos/documents-repo';

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

const ts = '2026-03-02T10:00:00.000Z';
let oppId = '';
const newDoc = (id: string) => ({
  id, opportunityId: oppId, r2Key: `scan/${id}`, filename: `${id}.pdf`, contentType: 'application/pdf', byteSize: 10,
  tier: 2, uploadedBy: 'sc-staff', timestamp: ts, sha256: `sha-${id}`, scanSkipped: false, skipProvider: 'skip',
  auditId: `ins-${id}`, requestId: 'rq',
});
const scan = (id: string, over: Partial<ScanRecord> = {}): ScanRecord => ({
  documentId: id, expectedSha256: `sha-${id}`, scanStatus: 'clean', provider: 'prov', reference: `job-${id}`,
  verdict: 'clean', sha256: `sha-${id}`, scannedAt: ts, engineVersion: 'v1', auditId: `sa-${id}`, actorId: 'sc-staff',
  requestId: 'rq', auditDetailsJson: '{}', timestamp: ts, ...over,
});
const n = async (sql: string, ...a: string[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;

describe('documents repo: scan and delete', () => {
  it('runs its steps in order', async () => {
    await step('records a verified scan atomically with its audit row, once only', async () => {
      await env.DB.prepare(
        "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('sc-staff', 'sc@example.com', 'S', 'admin', 'staff', 'active', ?, ?)",
      ).bind(ts, ts).run();
      oppId = (await env.DB.prepare('SELECT id FROM opportunities LIMIT 1').first<{ id: string }>())!.id;
      await insertDocumentWithAudit(env.DB, newDoc('s1'));
      const found = await findDocumentForScan(env.DB, 's1');
      expect(found).toMatchObject({ id: 's1', scanStatus: 'pending', sha256: 'sha-s1' });
      expect(await findDocumentForScan(env.DB, 'nope')).toBeNull();
  
      await recordScanResult(env.DB, scan('s1'));
      expect(await loadSavedScan(env.DB, 's1')).toMatchObject({ scanStatus: 'clean', scanJobId: 'job-s1' });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'sa-s1' AND action = 'document.scan.clean'")).toBe(1);
  
      // A second scan of the same (no longer pending) document changes nothing and writes no audit row.
      await recordScanResult(env.DB, scan('s1', { auditId: 'sa-s1-b', reference: 'job-other', scanStatus: 'rejected' }));
      expect(await loadSavedScan(env.DB, 's1')).toMatchObject({ scanStatus: 'clean', scanJobId: 'job-s1' });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'sa-s1-b'")).toBe(0);
    });

    await step('refuses a result whose digest does not match the stored one (object changed)', async () => {
      await insertDocumentWithAudit(env.DB, newDoc('s2'));
      await recordScanResult(env.DB, scan('s2', { expectedSha256: 'tampered' }));
      expect(await loadSavedScan(env.DB, 's2')).toMatchObject({ scanStatus: 'pending', scanJobId: null });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'sa-s2'")).toBe(0);
    });

    await step('stores a rejected verdict', async () => {
      await insertDocumentWithAudit(env.DB, newDoc('s3'));
      await recordScanResult(env.DB, scan('s3', { scanStatus: 'rejected', verdict: 'infected' }));
      expect((await loadSavedScan(env.DB, 's3'))?.scanStatus).toBe('rejected');
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'sa-s3' AND action = 'document.scan.rejected'")).toBe(1);
    });

    await step('manual status change and its audit row commit together', async () => {
      await insertDocumentWithAudit(env.DB, newDoc('s4'));
      expect(await findDocumentForReview(env.DB, 's4')).toMatchObject({ id: 's4', opportunityId: oppId });
      expect(await findDocumentForReview(env.DB, 'nope')).toBeNull();
      await setScanStatusManually(env.DB, { documentId: 's4', status: 'rejected', auditId: 'man-s4', actorId: 'sc-staff', requestId: 'rq', detailsJson: '{"reason":"bad"}', timestamp: ts });
      expect((await loadSavedScan(env.DB, 's4'))?.scanStatus).toBe('rejected');
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'man-s4'")).toBe(1);
      // Duplicate audit id makes the batch fail: the status change must roll back too.
      await insertDocumentWithAudit(env.DB, newDoc('s5'));
      await expect(setScanStatusManually(env.DB, { documentId: 's5', status: 'rejected', auditId: 'man-s4', actorId: 'sc-staff', requestId: 'rq', detailsJson: '{}', timestamp: ts })).rejects.toThrow();
      expect((await loadSavedScan(env.DB, 's5'))?.scanStatus).toBe('pending');
    });

    await step('finds and deletes a document row', async () => {
      await insertDocumentWithAudit(env.DB, newDoc('s6'));
      expect(await findDocumentForDelete(env.DB, 's6')).toMatchObject({ id: 's6', r2Key: 'scan/s6', opportunityId: oppId });
      await deleteDocumentRow(env.DB, 's6');
      expect(await findDocumentForDelete(env.DB, 's6')).toBeNull();
    });
  });
});
