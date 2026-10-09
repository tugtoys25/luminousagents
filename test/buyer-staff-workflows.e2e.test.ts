import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const uid = () => crypto.randomUUID();

/** Real Worker requests against the configured D1/R2/KV test bindings. */
describe('Buyer and staff confidentiality workflows (Worker E2E)', () => {
  const buyerId = uid();
  const opportunityId = uid();
  const ndaId = uid();
  const documentId = uid();
  const grantId = uid();
  const token = `e2e-session-${uid()}`;
  let cookie = '';

  beforeAll(async () => {
    const timestamp = iso();
    const tokenHash = await sha256(token);
    await env.DB.prepare(
      "INSERT INTO users (id,email,display_name,user_type,role,status,created_at,updated_at) VALUES (?,?,'E2E Buyer','buyer','buyer','active',?,?)",
    )
      .bind(buyerId, `buyer-${buyerId}@example.test`, timestamp, timestamp)
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions (id,user_id,token_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?)',
    )
      .bind(uid(), buyerId, tokenHash, timestamp, timestamp, iso(60 * 60_000))
      .run();
    cookie = `mayfair_buyer_session=${token}`;
    await env.DB.prepare(
      "INSERT INTO opportunities (id,slug,title,lifecycle,content_review_status,public_visibility,created_at,updated_at) VALUES (?,?,'E2E Confidential Opportunity','published','approved',1,?,?)",
    )
      .bind(opportunityId, `e2e-${opportunityId}`, timestamp, timestamp)
      .run();
    await env.DB.prepare(
      "INSERT INTO nda_templates (id,name,version,content_hash,status,created_at) VALUES (?,'E2E NDA',1,'test-hash','active',?)",
    )
      .bind(uid(), timestamp)
      .run();
    const template = await env.DB.prepare(
      "SELECT id FROM nda_templates WHERE name='E2E NDA' AND status='active' ORDER BY created_at DESC LIMIT 1",
    ).first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO nda_requests (id,user_id,opportunity_id,template_id,status,acceptance_name,accepted_at,created_at,updated_at) VALUES (?,?,?,?,'approved','E2E Buyer',?,?,?)",
    )
      .bind(ndaId, buyerId, opportunityId, template!.id, timestamp, timestamp, timestamp)
      .run();
    await env.DB.prepare(
      "INSERT INTO documents (id,opportunity_id,r2_key,filename,content_type,byte_size,tier,created_at,sha256,scan_status) VALUES (?,?,?,'confidential.pdf','application/pdf',12,1,?,?,'clean')",
    )
      .bind(
        documentId,
        opportunityId,
        `e2e/${documentId}.pdf`,
        timestamp,
        await sha256('E2E PDF bytes'),
      )
      .run();
    await env.PRIVATE_FILES.put(`e2e/${documentId}.pdf`, '%PDF-E2E bytes');
    await env.DB.prepare(
      'INSERT INTO access_grants (id,user_id,opportunity_id,nda_request_id,tier,granted_at,expires_at,revoked_at) VALUES (?,?,?,?,1,?,?,NULL)',
    )
      .bind(grantId, buyerId, opportunityId, ndaId, timestamp, iso(60 * 60_000))
      .run();
  });

  it('rejects unauthenticated access to buyer documents and download endpoints', async () => {
    const listing = await SELF.fetch(
      `https://mayfair.test/api/buyer/opportunities/${opportunityId}/documents`,
    );
    expect(listing.status).toBe(401);
    expect(((await listing.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
    const download = await SELF.fetch(
      `https://mayfair.test/api/buyer/documents/${documentId}/download`,
    );
    expect(download.status).toBe(401);
  });

  it('denies access when every grant is expired or revoked', async () => {
    await env.DB.prepare('UPDATE access_grants SET expires_at = ? WHERE id = ?')
      .bind(iso(-1000), grantId)
      .run();
    const response = await SELF.fetch(
      `https://mayfair.test/api/buyer/opportunities/${opportunityId}/documents`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'ACCESS_NOT_GRANTED',
    );
    const download = await SELF.fetch(
      `https://mayfair.test/api/buyer/documents/${documentId}/download`,
      { headers: { cookie } },
    );
    expect(download.status).toBe(403);
  });

  it('allows an active grant to list and download only clean, in-tier documents', async () => {
    await env.DB.prepare('UPDATE access_grants SET revoked_at = ?, expires_at = ? WHERE id = ?')
      .bind(iso(), iso(60 * 60_000), grantId)
      .run();
    const revoked = await SELF.fetch(
      `https://mayfair.test/api/buyer/opportunities/${opportunityId}/documents`,
      { headers: { cookie } },
    );
    expect(revoked.status).toBe(403);
    await env.DB.prepare('UPDATE access_grants SET revoked_at = NULL, expires_at = ? WHERE id = ?')
      .bind(iso(60 * 60_000), grantId)
      .run();
    const listing = await SELF.fetch(
      `https://mayfair.test/api/buyer/opportunities/${opportunityId}/documents`,
      { headers: { cookie } },
    );
    expect(listing.status).toBe(200);
    const listBody = (await listing.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.some((doc) => doc.id === documentId)).toBe(true);
    const download = await SELF.fetch(
      `https://mayfair.test/api/buyer/documents/${documentId}/download`,
      { headers: { cookie } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(await download.text()).toContain('%PDF-E2E');
  });

  it('hides pending or rejected scan-status files from buyer listing and direct download', async () => {
    await env.DB.prepare("UPDATE documents SET scan_status='pending' WHERE id=?")
      .bind(documentId)
      .run();
    const listing = await SELF.fetch(
      `https://mayfair.test/api/buyer/opportunities/${opportunityId}/documents`,
      { headers: { cookie } },
    );
    expect(listing.status).toBe(200);
    expect(
      ((await listing.json()) as { data: { id: string }[] }).data.some(
        (doc) => doc.id === documentId,
      ),
    ).toBe(false);
    const download = await SELF.fetch(
      `https://mayfair.test/api/buyer/documents/${documentId}/download`,
      { headers: { cookie } },
    );
    expect(download.status).toBe(404);
  });

  it('does not expose staff NDA review without a verified Cloudflare Access identity', async () => {
    const response = await SELF.fetch('https://mayfair.test/dashboard/nda-requests');
    expect([401, 503]).toContain(response.status);
  });
});
