import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { Hono } from 'hono';
import {
  type AdminApp,
  audit,
  id,
  mediaSignatureMatches,
  now,
  purgeOpportunityPublicCache,
} from '../shared';

const admin = new Hono<AdminApp>();

admin.post(
  '/opportunities/:id/media',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const opportunityId = c.req.param('id');
    const opportunity = await c.env.DB.prepare(
      'SELECT id, slug, country, public_visibility AS publicVisibility, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?',
    )
      .bind(opportunityId)
      .first<{
        id: string;
        slug: string;
        country: string | null;
        publicVisibility: number;
        assignedBrokerId: string | null;
      }>();
    if (
      !opportunity ||
      (c.get('staff').role === 'broker' && opportunity.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);

    const body = await c.req.parseBody();
    const upload = body.file;
    const altText = typeof body.altText === 'string' ? body.altText.trim() : '';
    if (
      !(upload instanceof File) ||
      upload.size < 1 ||
      upload.size > 8 * 1024 * 1024 ||
      altText.length < 3 ||
      altText.length > 240
    )
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Choose a JPG, PNG, WebP or GIF up to 8 MiB and provide descriptive alternative text.',
          },
        },
        422,
      );

    const contentType = upload.type;
    const bytes = new Uint8Array(await upload.arrayBuffer());
    // JPEG, PNG, WebP and GIF (PHP-edition parity); signatures are checked against the declared type.
    const listingImageExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    const imageExt = listingImageExt[contentType];
    if (!imageExt || !mediaSignatureMatches(contentType, bytes))
      return c.json(
        {
          error: {
            code: 'INVALID_FILE_SIGNATURE',
            message: 'Image bytes do not match JPEG, PNG, WebP or GIF.',
          },
        },
        415,
      );

    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const mediaId = id();
    const key = `opportunities/${opportunityId}/media/${mediaId}.${imageExt}`;
    const timestamp = now();
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { sha256, mediaId },
    });
    const order = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM opportunity_media WHERE opportunity_id = ?',
    )
      .bind(opportunityId)
      .first<{ next: number }>();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
        ).bind(timestamp, opportunityId),
        c.env.DB.prepare(
          "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'opportunity.media_change_requires_review', 'opportunity', ?, ?, '{}', ? WHERE changes() > 0",
        ).bind(id(), c.get('staff').id, opportunityId, c.get('requestId'), timestamp),
        c.env.DB.prepare(
          'INSERT INTO opportunity_media (id, opportunity_id, r2_key, alt_text, sort_order, created_at, content_type, byte_size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          mediaId,
          opportunityId,
          key,
          altText,
          order?.next ?? 0,
          timestamp,
          contentType,
          upload.size,
          sha256,
        ),
        c.env.DB.prepare(
          "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'opportunity.media_uploaded', 'opportunity_media', ?, ?, ?, ?)",
        ).bind(
          id(),
          c.get('staff').id,
          mediaId,
          c.get('requestId'),
          JSON.stringify({ opportunityId, byteSize: upload.size, contentType, sha256 }),
          timestamp,
        ),
      ]);
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    const cachePurge = await purgeOpportunityPublicCache(
      c.env,
      opportunity.slug,
      opportunity.country,
    );
    return c.json(
      {
        data: {
          id: mediaId,
          opportunityId,
          altText,
          sortOrder: order?.next ?? 0,
          contentType,
          byteSize: upload.size,
          sha256,
          cachePurge,
        },
      },
      201,
    );
  },
);

admin.post(
  '/opportunities/:id/media/from-library',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const opportunityId = c.req.param('id');
    const opportunity = await c.env.DB.prepare(
      'SELECT id, slug, country, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?',
    )
      .bind(opportunityId)
      .first<{ id: string; slug: string; country: string | null; assignedBrokerId: string | null }>();
    if (
      !opportunity ||
      (c.get('staff').role === 'broker' && opportunity.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
    const body = z
      .object({
        mediaUrl: z.string().trim().max(300).optional(),
        assetId: z.string().trim().min(1).max(80).optional(),
        altText: z.string().trim().max(240).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    // The shared Media picker returns a public URL such as /media/<slug-or-id>.
    const urlMatch = body.success ? body.data.mediaUrl?.match(/^\/media\/([^/?#]+)$/) : null;
    let lookup = body.success ? body.data.assetId : undefined;
    if (!lookup && urlMatch?.[1]) {
      try {
        lookup = decodeURIComponent(urlMatch[1]);
      } catch {
        lookup = undefined;
      }
    }
    if (!body.success || !lookup)
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Choose an image from the Media library.' } }, 422);
    const asset = await c.env.DB.prepare(
      "SELECT id, r2_key AS r2Key, content_type AS contentType, byte_size AS byteSize, alt_text AS altText, visibility FROM media_assets WHERE (id = ?1 OR public_slug = ?1) AND visibility = 'public'",
    )
      .bind(lookup)
      .first<{
        id: string;
        r2Key: string;
        contentType: string;
        byteSize: number;
        altText: string | null;
        visibility: string;
      }>();
    if (!asset)
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'That image is not available. Make sure it is public in the Media library.' } },
        404,
      );
    if (asset.visibility !== 'public')
      return c.json(
        { error: { code: 'NOT_PUBLIC', message: 'Publish this image in the Media library before using it on a listing.' } },
        409,
      );
    const altText = (body.data.altText || asset.altText || '').trim();
    if (altText.length < 3 || altText.length > 240)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Describe the image in 3 to 240 characters.' } },
        422,
      );
    const attachExt: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const attachImageExt = attachExt[asset.contentType];
    if (!attachImageExt || asset.byteSize > 8 * 1024 * 1024)
      return c.json(
        { error: { code: 'UNSUPPORTED_IMAGE', message: 'Only JPG, PNG, WebP or GIF images up to 8 MiB can be added to a listing.' } },
        415,
      );
    const object = await c.env.PRIVATE_FILES.get(asset.r2Key);
    if (!object)
      return c.json({ error: { code: 'NOT_FOUND', message: 'The image file is missing from storage.' } }, 404);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!mediaSignatureMatches(asset.contentType, bytes))
      return c.json({ error: { code: 'INVALID_FILE_SIGNATURE', message: 'Image bytes do not match JPEG, PNG, WebP or GIF.' } }, 415);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
    const mediaId = id();
    const key = `opportunities/${opportunityId}/media/${mediaId}.${attachImageExt}`;
    const timestamp = now();
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: asset.contentType, cacheControl: 'private, no-store' },
      customMetadata: { sha256, mediaId, libraryAssetId: asset.id },
    });
    const order = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM opportunity_media WHERE opportunity_id = ?',
    )
      .bind(opportunityId)
      .first<{ next: number }>();
    try {
      await c.env.DB.batch([
        // Same rule as an upload: changing the pictures of a live listing sends it back for approval.
        c.env.DB.prepare(
          "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
        ).bind(timestamp, opportunityId),
        c.env.DB.prepare(
          'INSERT INTO opportunity_media (id, opportunity_id, r2_key, alt_text, sort_order, created_at, content_type, byte_size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(mediaId, opportunityId, key, altText, order?.next ?? 0, timestamp, asset.contentType, bytes.length, sha256),
      ]);
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    await c.env.DB.prepare("UPDATE media_assets SET alt_text = ?, updated_at = ? WHERE id = ? AND (alt_text IS NULL OR alt_text = '')")
      .bind(altText, timestamp, asset.id)
      .run();
    await audit(c, 'opportunity.media_added_from_library', 'opportunity_media', mediaId, {
      opportunityId,
      libraryAssetId: asset.id,
      byteSize: bytes.length,
      sha256,
    });
    const cachePurge = await purgeOpportunityPublicCache(c.env, opportunity.slug, opportunity.country);
    return c.json({ data: { id: mediaId, opportunityId, altText, sortOrder: order?.next ?? 0, cachePurge } }, 201);
  },
);

admin.get(
  '/opportunities/:id/media',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const result = await c.env.DB.prepare(
      'SELECT m.id, m.alt_text AS altText, m.sort_order AS sortOrder, m.content_type AS contentType, m.byte_size AS byteSize, m.sha256 FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.opportunity_id = ? AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY m.sort_order, m.created_at',
    )
      .bind(c.req.param('id'), c.get('staff').role === 'broker' ? 1 : 0, c.get('staff').id)
      .all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.delete(
  '/opportunities/:id/media/:mediaId',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const media = await c.env.DB.prepare(
      'SELECT m.id, m.r2_key AS r2Key, o.slug, o.country, o.assigned_broker_id AS assignedBrokerId FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.id = ? AND m.opportunity_id = ?',
    )
      .bind(c.req.param('mediaId'), c.req.param('id'))
      .first<{
        id: string;
        r2Key: string;
        slug: string;
        country: string | null;
        assignedBrokerId: string | null;
      }>();
    if (
      !media ||
      (c.get('staff').role === 'broker' && media.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Listing image not found.' } }, 404);
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
      ).bind(timestamp, c.req.param('id')),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'opportunity.media_change_requires_review', 'opportunity', ?, ?, '{}', ? WHERE changes() > 0",
      ).bind(id(), c.get('staff').id, c.req.param('id'), c.get('requestId'), timestamp),
      c.env.DB.prepare('DELETE FROM opportunity_media WHERE id = ?').bind(media.id),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'opportunity.media_deleted', 'opportunity_media', ?, ?, '{}', ?)",
      ).bind(id(), c.get('staff').id, media.id, c.get('requestId'), timestamp),
    ]);
    await c.env.PRIVATE_FILES.delete(media.r2Key);
    const cachePurge = await purgeOpportunityPublicCache(c.env, media.slug, media.country);
    return c.json({ data: { deleted: true, cachePurge } });
  },
);

export default admin;
