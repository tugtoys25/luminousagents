import { SELF, env } from 'cloudflare:test';
import { hashPassword } from '../../src/auth/password';
import { describe, expect, it } from 'vitest';

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('buyer sign-in through authorised document download', () => {
  it('requires an active session and an active grant for a clean private document', async () => {
    const id = () => crypto.randomUUID();
    const userId = id();
    const opportunityId = id();
    const ndaRequestId = id();
    const grantId = id();
    const documentId = id();
    const email = `workflow-${id()}@example.test`;
    const password = 'Correct-horse-battery-7';
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const bytes = new TextEncoder().encode('%PDF-1.4\nMayfair staging-only test file\n%%EOF');
    const objectKey = `test-fixtures/${documentId}.pdf`;
    const fileHash = await sha256(bytes);
    await env.DB.prepare(
      "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,created_at,updated_at) VALUES (?,?,'Workflow Buyer','buyer','buyer','active',?,?,?)",
    )
      .bind(userId, email, await hashPassword(password), timestamp, timestamp)
      .run();
    try {
      await env.DB.prepare(
        "INSERT INTO opportunities (id,slug,title,lifecycle,content_review_status,public_visibility,last_verified_at,published_at,created_at,updated_at,classification) VALUES (?,?,?,'published','approved',1,?,?,?,?,'public')",
      )
        .bind(
          opportunityId,
          `workflow-${opportunityId}`,
          'Staging-only workflow listing',
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        )
        .run();
      await env.DB.prepare(
        "INSERT INTO nda_requests (id,user_id,opportunity_id,status,created_at,updated_at) VALUES (?,?,?,'approved',?,?)",
      )
        .bind(ndaRequestId, userId, opportunityId, timestamp, timestamp)
        .run();
      await env.DB.prepare(
        'INSERT INTO access_grants (id,user_id,opportunity_id,nda_request_id,tier,granted_at,expires_at) VALUES (?,?,?,?,2,?,?)',
      )
        .bind(grantId, userId, opportunityId, ndaRequestId, timestamp, expiresAt)
        .run();
      await env.PRIVATE_FILES.put(objectKey, bytes, {
        httpMetadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
      });
      await env.DB.prepare(
        "INSERT INTO documents (id,opportunity_id,r2_key,filename,content_type,byte_size,tier,created_at,sha256,scan_status) VALUES (?,?,?,?,?,?,2,?,?,'clean')",
      )
        .bind(
          documentId,
          opportunityId,
          objectKey,
          'staging-test.pdf',
          'application/pdf',
          bytes.length,
          timestamp,
          fileHash,
        )
        .run();

      const signIn = await SELF.fetch('https://mayfair.test/api/buyer/auth/login', {
        method: 'POST',
        headers: { origin: 'https://mayfair.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      expect(signIn.status).toBe(200);
      const setCookie = signIn.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      const cookie = setCookie.split(';')[0]!;

      const documents = await SELF.fetch(
        `https://mayfair.test/api/buyer/opportunities/${opportunityId}/documents`,
        { headers: { cookie } },
      );
      expect(documents.status).toBe(200);
      expect(
        ((await documents.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id),
      ).toContain(documentId);

      const download = await SELF.fetch(
        `https://mayfair.test/api/buyer/documents/${documentId}/download`,
        { headers: { cookie } },
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toContain('Mayfair staging-only test file');

      await env.DB.prepare('UPDATE access_grants SET revoked_at=? WHERE id=?')
        .bind(new Date().toISOString(), grantId)
        .run();
      const revokedDownload = await SELF.fetch(
        `https://mayfair.test/api/buyer/documents/${documentId}/download`,
        { headers: { cookie } },
      );
      expect(revokedDownload.status).toBe(403);
    } finally {
      await env.PRIVATE_FILES.delete(objectKey);
      await env.DB.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
      await env.DB.prepare('DELETE FROM audit_logs WHERE actor_user_id=?').bind(userId).run();
      await env.DB.prepare('DELETE FROM documents WHERE id=?').bind(documentId).run();
      await env.DB.prepare('DELETE FROM access_grants WHERE id=?').bind(grantId).run();
      await env.DB.prepare('DELETE FROM nda_requests WHERE id=?').bind(ndaRequestId).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId).run();
      await env.DB.prepare('DELETE FROM opportunities WHERE id=?').bind(opportunityId).run();
      await env.DB.prepare('DELETE FROM users WHERE id=?').bind(userId).run();
    }
  });
});
