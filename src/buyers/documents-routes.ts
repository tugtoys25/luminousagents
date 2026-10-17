import { Hono } from 'hono';
import { publicOpportunityExists, findActiveGrant, listDocumentsAtTier, findAccessibleDocument } from './buyers-repo';
import { now, jsonError, requireBuyer, audit } from './shared';
import type { BuyerApp } from './shared';

const buyers = new Hono<BuyerApp>();

buyers.get('/api/buyer/opportunities/:id/documents', requireBuyer, async (c) => {
  if (!(await publicOpportunityExists(c.env.DB, c.req.param('id') ?? '')))
    return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const grant = await findActiveGrant(c.env.DB, c.get('buyer').id, c.req.param('id') ?? '', now());
  if (!grant)
    return jsonError(c, 403, 'ACCESS_NOT_GRANTED', 'Approved NDA and active access are required.');
  return c.json({ data: await listDocumentsAtTier(c.env.DB, c.req.param('id') ?? '', grant.tier) });
});

buyers.get('/api/buyer/documents/:documentId/download', requireBuyer, async (c) => {
  const doc = await findAccessibleDocument(c.env.DB, c.req.param('documentId') ?? '');
  if (!doc) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  const grant = await findActiveGrant(c.env.DB, c.get('buyer').id, doc.opportunityId, now());
  if (!grant || doc.tier > grant.tier)
    return jsonError(c, 403, 'ACCESS_NOT_GRANTED', 'Approved NDA and active access are required.');
  const file = await c.env.PRIVATE_FILES.get(doc.r2Key);
  if (!file) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  await audit(c, 'document.downloaded', 'document', doc.id, { opportunityId: doc.opportunityId });
  c.header('Content-Type', doc.contentType);
  c.header('Content-Length', String(file.size));
  c.header(
    'Content-Disposition',
    `attachment; filename="${doc.filename.replace(/["\\\r\n]/g, '_')}"`,
  );
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(file.body as ReadableStream, 200);
});

const PREVIEW_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

buyers.get('/api/buyer/documents/:documentId/preview', requireBuyer, async (c) => {
  const doc = await findAccessibleDocument(c.env.DB, c.req.param('documentId') ?? '');
  if (!doc) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  const grant = await findActiveGrant(c.env.DB, c.get('buyer').id, doc.opportunityId, now());
  if (!grant || doc.tier > grant.tier)
    return jsonError(c, 403, 'ACCESS_NOT_GRANTED', 'Approved NDA and active access are required.');
  const baseType = doc.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!PREVIEW_TYPES.has(baseType))
    return jsonError(
      c,
      415,
      'PREVIEW_NOT_AVAILABLE',
      'Preview is not available for this file type. You can download it instead.',
    );
  const file = await c.env.PRIVATE_FILES.get(doc.r2Key);
  if (!file) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  await audit(c, 'document.previewed', 'document', doc.id, { opportunityId: doc.opportunityId });
  c.header('Content-Type', baseType === 'text/plain' ? 'text/plain; charset=utf-8' : baseType);
  c.header('Content-Length', String(file.size));
  c.header('Content-Disposition', `inline; filename="${doc.filename.replace(/["\\\r\n]/g, '_')}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(file.body as ReadableStream, 200);
});


export default buyers;
