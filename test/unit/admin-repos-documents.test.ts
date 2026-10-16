import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  changeScannerMode, countPendingDocuments, insertDocumentWithAudit, listDocuments, opportunityExists,
  settingUpdatedAt, type NewDocument,
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

const ts = '2026-03-01T10:00:00.000Z';
let oppId = '';
const doc = (id: string, over: Partial<NewDocument> = {}): NewDocument => ({
  id, opportunityId: oppId, r2Key: `k/${id}`, filename: `${id}.pdf`, contentType: 'application/pdf',
  byteSize: 10, tier: 2, uploadedBy: 'doc-staff', timestamp: ts, sha256: `sha-${id}`, scanSkipped: false,
  skipProvider: 'scanner-disabled-test', auditId: `aud-${id}`, requestId: 'rq', ...over,
});

describe('documents repo', () => {
  it('runs its steps in order', async () => {
    await step('stores pending documents and clean-skipped ones with their audit rows', async () => {
      await env.DB.prepare(
        "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('doc-staff', 'doc@example.com', 'D', 'admin', 'staff', 'active', ?, ?)",
      ).bind(ts, ts).run();
      oppId = (await env.DB.prepare('SELECT id FROM opportunities LIMIT 1').first<{ id: string }>())!.id;
      expect(await opportunityExists(env.DB, oppId)).toBe(true);
      expect(await opportunityExists(env.DB, 'nope')).toBe(false);
  
      await insertDocumentWithAudit(env.DB, doc('d1'));
      await insertDocumentWithAudit(env.DB, doc('d2', { scanSkipped: true }));
      const rows = await listDocuments(env.DB, oppId);
      expect(rows.find((r) => r['id'] === 'd1')?.['scanStatus']).toBe('pending');
      const d2 = rows.find((r) => r['id'] === 'd2');
      expect(d2).toMatchObject({ scanStatus: 'clean', scanProvider: 'scanner-disabled-test' });
      const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE id = 'aud-d1'").first<{ action: string }>();
      expect(a?.action).toBe('document.uploaded');
      expect((await listDocuments(env.DB, 'other-opp')).length).toBe(0);
      expect((await listDocuments(env.DB, '')).length).toBeGreaterThanOrEqual(2);
    });

    await step('rolls back the document when its audit row cannot be written', async () => {
      let threw = false;
      try {
        await insertDocumentWithAudit(env.DB, doc('d3', { auditId: 'aud-d1' })); // duplicate audit id
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const row = await env.DB.prepare("SELECT id FROM documents WHERE id = 'd3'").first();
      expect(row).toBeNull();
    });

    await step('switching the scanner off releases pending documents atomically with the setting and audit', async () => {
      expect(await countPendingDocuments(env.DB)).toBe(1);
      expect(await settingUpdatedAt(env.DB, 'scanner_mode')).toBeNull();
      await changeScannerMode(env.DB, {
        settingKey: 'scanner_mode', mode: 'disabled', staffId: 'doc-staff', timestamp: '2026-04-01T00:00:00.000Z',
        releasePending: true, skipProvider: 'scanner-disabled-test', auditId: 'aud-scan', requestId: 'rq',
        auditDetails: { from: 'enforced', to: 'disabled', reason: 'test', releasedPending: 1 },
      });
      expect(await countPendingDocuments(env.DB)).toBe(0);
      expect(await settingUpdatedAt(env.DB, 'scanner_mode')).toBe('2026-04-01T00:00:00.000Z');
      const released = await env.DB.prepare("SELECT scan_status AS s, scan_digest AS d, sha256 FROM documents WHERE id='d1'").first<{ s: string; d: string; sha256: string }>();
      expect(released?.s).toBe('clean');
      expect(released?.d).toBe(released?.sha256);
      const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE id = 'aud-scan'").first<{ action: string }>();
      expect(a?.action).toBe('platform.scanner_mode_changed');
    });

    await step('without releasePending, switching modes leaves pending documents pending', async () => {
      await insertDocumentWithAudit(env.DB, doc('d4'));
      await changeScannerMode(env.DB, {
        settingKey: 'scanner_mode', mode: 'enforced', staffId: 'doc-staff', timestamp: '2026-05-01T00:00:00.000Z',
        releasePending: false, skipProvider: 'x', auditId: 'aud-scan2', requestId: 'rq', auditDetails: {},
      });
      expect(await countPendingDocuments(env.DB)).toBe(1);
    });
  });
});
