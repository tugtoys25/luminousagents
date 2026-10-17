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
import {
  attachImage,
  backfillAssetAltText,
  deleteImage,
  findMediaForDelete,
  findOpportunityForMedia,
  findPublicLibraryAsset,
  listOpportunityMedia,
  nextSortOrder,
} from '../repos/opportunity-media-repo';

const admin = new Hono<AdminApp>();

admin.post(
  '/opportunities/:id/media',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const opportunityId = c.req.param('id');
    const opportunity = await findOpportunityForMedia(c.env.DB, opportunityId);
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
    const sortOrder = await nextSortOrder(c.env.DB, opportunityId);
    try {
      await attachImage(c.env.DB, {
        mediaId,
        opportunityId,
        r2Key: key,
        altText,
        sortOrder,
        contentType,
        byteSize: upload.size,
        sha256,
        timestamp,
        actorId: c.get('staff').id,
        requestId: c.get('requestId'),
        reviewAuditId: id(),
        uploadAudit: {
          id: id(),
          detailsJson: JSON.stringify({ opportunityId, byteSize: upload.size, contentType, sha256 }),
        },
      });
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
          sortOrder,
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
    const opportunity = await findOpportunityForMedia(c.env.DB, opportunityId);
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
    const asset = await findPublicLibraryAsset(c.env.DB, lookup);
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
    const sortOrder = await nextSortOrder(c.env.DB, opportunityId);
    try {
      await attachImage(c.env.DB, {
        mediaId,
        opportunityId,
        r2Key: key,
        altText,
        sortOrder,
        contentType: asset.contentType,
        byteSize: bytes.length,
        sha256,
        timestamp,
        actorId: c.get('staff').id,
        requestId: c.get('requestId'),
        reviewAuditId: id(),
        uploadAudit: null,
      });
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    await backfillAssetAltText(c.env.DB, asset.id, altText, timestamp);
    await audit(c, 'opportunity.media_added_from_library', 'opportunity_media', mediaId, {
      opportunityId,
      libraryAssetId: asset.id,
      byteSize: bytes.length,
      sha256,
    });
    const cachePurge = await purgeOpportunityPublicCache(c.env, opportunity.slug, opportunity.country);
    return c.json({ data: { id: mediaId, opportunityId, altText, sortOrder, cachePurge } }, 201);
  },
);

admin.get(
  '/opportunities/:id/media',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const rows = await listOpportunityMedia(
      c.env.DB,
      c.req.param('id'),
      c.get('staff').role === 'broker',
      c.get('staff').id,
    );
    return c.json({ data: rows });
  },
);

admin.delete(
  '/opportunities/:id/media/:mediaId',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const media = await findMediaForDelete(c.env.DB, c.req.param('mediaId'), c.req.param('id'));
    if (
      !media ||
      (c.get('staff').role === 'broker' && media.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Listing image not found.' } }, 404);
    const timestamp = now();
    await deleteImage(c.env.DB, {
      mediaId: media.id,
      opportunityId: c.req.param('id'),
      timestamp,
      actorId: c.get('staff').id,
      requestId: c.get('requestId'),
      reviewAuditId: id(),
      deleteAuditId: id(),
    });
    await c.env.PRIVATE_FILES.delete(media.r2Key);
    const cachePurge = await purgeOpportunityPublicCache(c.env, media.slug, media.country);
    return c.json({ data: { deleted: true, cachePurge } });
  },
);

export default admin;
