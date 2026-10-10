import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('public listing media', () => {
  it('serves only media belonging to an approved, published, public listing and verifies exact bytes', async () => {
    const id = () => crypto.randomUUID();
    const opportunityId = id();
    const mediaId = id();
    const timestamp = new Date().toISOString();
    const objectKey = `test-fixtures/${mediaId}.png`;
    const bytes = new TextEncoder().encode('test-only cover image fixture');
    const hash = await sha256(bytes);
    await env.DB.prepare(
      "INSERT INTO opportunities (id,slug,title,lifecycle,content_review_status,public_visibility,last_verified_at,published_at,created_at,updated_at,classification) VALUES (?,?,?,'published','approved',1,?,?,?,?,'public')",
    )
      .bind(
        opportunityId,
        `media-${opportunityId}`,
        'Public test listing',
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    await env.PRIVATE_FILES.put(objectKey, bytes, { httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare(
      'INSERT INTO opportunity_media (id,opportunity_id,r2_key,alt_text,sort_order,created_at,content_type,byte_size,sha256) VALUES (?,?,?,?,0,?,?,?,?)',
    )
      .bind(
        mediaId,
        opportunityId,
        objectKey,
        'Test cover image',
        timestamp,
        'image/png',
        bytes.length,
        hash,
      )
      .run();
    try {
      const response = await SELF.fetch(
        `https://mayfair.test/media/opportunities/${opportunityId}/${mediaId}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('image/png');
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
        'test-only cover image fixture',
      );

      await env.DB.prepare("UPDATE opportunities SET classification='confidential' WHERE id=?")
        .bind(opportunityId)
        .run();
      const hidden = await SELF.fetch(
        `https://mayfair.test/media/opportunities/${opportunityId}/${mediaId}`,
      );
      expect(hidden.status).toBe(404);
    } finally {
      await env.PRIVATE_FILES.delete(objectKey);
      await env.DB.prepare('DELETE FROM opportunity_media WHERE id=?').bind(mediaId).run();
      await env.DB.prepare('DELETE FROM opportunities WHERE id=?').bind(opportunityId).run();
    }
  });
});
