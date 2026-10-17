import { Hono } from 'hono';
import { z } from 'zod';
import { scanR2Document, ScannerError, type VerifiedScan } from '../security/malware-scanner';
import { listNdaRequests, findActiveTemplate, findTemplateForAcknowledgement, findPublicOpportunityIdBySlug, hasOpenNdaRequest, insertNdaRequest, findPendingNdaForUpload, attachSignedPdf, recordSignedPdfUpload, detachSignedPdf } from './buyers-repo';
import { now, uuid, jsonError, digest, requireBuyer, audit, digestBytes } from './shared';
import type { BuyerApp } from './shared';

const buyers = new Hono<BuyerApp>();

buyers.get('/api/buyer/nda-requests', requireBuyer, async (c) => {
  return c.json({ data: await listNdaRequests(c.env.DB, c.get('buyer').id) });
});

const BOOTSTRAP_NDA_TEXT = `CONFIDENTIALITY AND NON-DISCLOSURE ACKNOWLEDGEMENT\n\nVersion 1 — draft template for legal review\n\nThe recipient acknowledges that information provided in connection with an opportunity may be confidential, may be incomplete, and must not be copied, disclosed, published, or used except to evaluate the opportunity and as authorised in writing. The recipient must restrict access to appropriate professional advisers who are bound by confidentiality obligations, protect materials using reasonable safeguards, and promptly notify the disclosing party of unauthorised access or disclosure. On request, the recipient must stop using the materials and return or securely destroy copies, subject to lawful record-retention duties. No representation, warranty, offer, or commitment is made by this acknowledgement. Any transaction remains subject to definitive written agreements, due diligence, applicable law, and any required regulatory approvals.\n\nBy entering their legal name and submitting an access request, the recipient records an acknowledgement of this template. This workflow is not represented as a qualified electronic signature and does not replace a counsel-approved agreement or signature process. The parties, governing law, remedies, data protection terms, permitted recipients, retention period, and transaction-specific restrictions must be completed or approved by qualified counsel before production use.\n`;

buyers.get('/api/buyer/nda-template/download', requireBuyer, async (c) => {
  const template = await findActiveTemplate(c.env.DB);
  if (!template)
    return jsonError(
      c,
      503,
      'NDA_NOT_CONFIGURED',
      'The NDA is not available yet. Please contact the team.',
    );
  let bytes: Uint8Array;
  if (template.r2Key) {
    const object = await c.env.PRIVATE_FILES.get(template.r2Key);
    if (!object)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_MISSING',
        'The active NDA template is unavailable. Please contact the team.',
      );
    bytes = new Uint8Array(await object.arrayBuffer());
  } else {
    // Bootstrap template: the exact text shown on screen (verified by hash below).
    bytes = new TextEncoder().encode(BOOTSTRAP_NDA_TEXT);
  }
  if ((await digestBytes(bytes)) !== template.contentHash)
    return jsonError(
      c,
      503,
      'NDA_TEMPLATE_HASH_MISMATCH',
      'The active NDA template failed integrity verification.',
    );
  await audit(c, 'nda.template_downloaded', 'nda_template', template.id, {
    version: template.version,
    templateHash: template.contentHash,
  });
  const safeName = `Mayfair-NDA-v${template.version}.txt`;
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Content-Length', String(bytes.byteLength));
  c.header('Content-Disposition', `attachment; filename="${safeName}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(bytes.buffer as ArrayBuffer, 200);
});

buyers.get('/api/buyer/nda-template', requireBuyer, async (c) => {
  const template = await findActiveTemplate(c.env.DB);
  if (!template)
    return jsonError(
      c,
      503,
      'NDA_NOT_CONFIGURED',
      'The NDA is not available yet. Please contact the team.',
    );
  let content: string;
  if (template.r2Key) {
    const object = await c.env.PRIVATE_FILES.get(template.r2Key);
    if (!object)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_MISSING',
        'The active NDA template is unavailable. Please contact the team.',
      );
    const bytes = await object.arrayBuffer();
    const digestValue = await digest(new TextDecoder().decode(bytes));
    if (digestValue !== template.contentHash)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_HASH_MISMATCH',
        'The active NDA template failed integrity verification.',
      );
    content = new TextDecoder().decode(bytes);
  } else {
    content = BOOTSTRAP_NDA_TEXT;
    if ((await digest(content)) !== template.contentHash)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_HASH_MISMATCH',
        'The active NDA template failed integrity verification.',
      );
  }
  return c.json({
    data: {
      id: template.id,
      name: template.name,
      version: template.version,
      contentHash: template.contentHash,
      content,
    },
  });
});

buyers.post('/api/buyer/opportunities/:slug/nda-requests', requireBuyer, async (c) => {
  const parsed = z
    .object({
      acceptanceName: z.string().trim().min(2).max(160),
      templateId: z.string().uuid().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return jsonError(
      c,
      422,
      'VALIDATION_ERROR',
      'Enter the full legal name used to acknowledge the NDA.',
    );
  const opportunityId = await findPublicOpportunityIdBySlug(c.env.DB, c.req.param('slug') ?? '');
  if (!opportunityId) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const template = await findTemplateForAcknowledgement(c.env.DB, parsed.data.templateId);
  if (!template)
    return jsonError(
      c,
      503,
      'NDA_NOT_CONFIGURED',
      'The NDA is not available yet. Please contact the team.',
    );
  if (!c.env.IP_HASH_SECRET)
    return jsonError(
      c,
      503,
      'NDA_AUDIT_NOT_CONFIGURED',
      'NDA acknowledgement audit is not configured. Please contact the team.',
    );
  const clientIp = c.req.header('cf-connecting-ip') ?? 'unknown';
  const acceptedIpHash = await digest(`${c.env.IP_HASH_SECRET}:${clientIp}`);
  const previous = await hasOpenNdaRequest(c.env.DB, c.get('buyer').id, opportunityId, now());
  if (previous)
    return jsonError(
      c,
      409,
      'REQUEST_EXISTS',
      'An NDA request already exists for this opportunity.',
    );
  const requestId = uuid();
  const notificationJobId = uuid();
  const timestamp = now();
  await insertNdaRequest(c.env.DB, {
    requestId,
    userId: c.get('buyer').id,
    opportunityId,
    templateId: template.id,
    acceptanceName: parsed.data.acceptanceName,
    acceptedIpHash,
    templateHash: template.contentHash,
    timestamp,
    auditId: uuid(),
    auditRequestId: c.get('requestId'),
    jobId: notificationJobId,
  });
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({
      type: 'nda.review_requested',
      jobId: notificationJobId,
    });
  } catch {
    /* queued DB job remains */
  }
  return c.json({ data: { id: requestId, status: 'pending', createdAt: timestamp } }, 201);
});

buyers.post('/api/buyer/nda-requests/:id/signed-pdf', requireBuyer, async (c) => {
  const request = await findPendingNdaForUpload(c.env.DB, c.req.param('id') ?? '', c.get('buyer').id);
  if (!request) return jsonError(c, 404, 'NOT_FOUND', 'Pending NDA request not found.');
  if (request.signedPdfR2Key)
    return jsonError(
      c,
      409,
      'SIGNED_PDF_ALREADY_UPLOADED',
      'A signed PDF is already attached to this request. Contact staff if a correction is required.',
    );
  const body = await c.req.parseBody();
  const file = body.file;
  if (
    !(file instanceof File) ||
    file.size < 8 ||
    file.size > 10 * 1024 * 1024 ||
    file.type.toLowerCase() !== 'application/pdf'
  ) {
    return jsonError(c, 422, 'INVALID_PDF', 'Upload a PDF up to 10 MiB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')
    return jsonError(c, 415, 'INVALID_PDF_SIGNATURE', 'The uploaded file is not a valid PDF.');
  const sha256 = await digestBytes(bytes);
  const key = `nda-signed/${request.id}/${uuid()}.pdf`;
  await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
    httpMetadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
    customMetadata: { ndaRequestId: request.id, buyerId: c.get('buyer').id, sha256 },
  });
  let scan: VerifiedScan;
  try {
    scan = await scanR2Document(c.env, {
      documentId: `nda-${request.id}`,
      r2Key: key,
      contentType: 'application/pdf',
      expectedSha256: sha256,
    });
    if (scan.verdict !== 'clean') {
      await c.env.PRIVATE_FILES.delete(key);
      return jsonError(
        c,
        415,
        'PDF_SCAN_REJECTED',
        'The signed PDF did not pass the security scan and was not retained.',
      );
    }
  } catch (error) {
    await c.env.PRIVATE_FILES.delete(key);
    if (error instanceof ScannerError)
      return jsonError(
        c,
        503,
        'SCANNER_UNAVAILABLE',
        'The document security scanner is unavailable. Please try again later.',
      );
    return jsonError(
      c,
      503,
      'SCANNER_UNAVAILABLE',
      'The document security scanner could not verify this file.',
    );
  }
  const timestamp = now();
  const notificationJobId = uuid();
  const attached = await attachSignedPdf(c.env.DB, {
    key,
    sha256,
    provider: scan.provider,
    scannedAt: scan.scannedAt,
    timestamp,
    requestId: request.id,
    userId: c.get('buyer').id,
  });
  if (!attached) {
    await c.env.PRIVATE_FILES.delete(key);
    return jsonError(
      c,
      409,
      'REQUEST_CHANGED',
      'The NDA request changed while the file was being checked. Refresh and try again.',
    );
  }
  try {
    await recordSignedPdfUpload(c.env.DB, {
      auditId: uuid(),
      userId: c.get('buyer').id,
      requestId: request.id,
      auditRequestId: c.get('requestId'),
      detailsJson: JSON.stringify({ sha256, scannerProvider: scan.provider, scannedAt: scan.scannedAt }),
      timestamp,
      jobId: notificationJobId,
    });
  } catch {
    await detachSignedPdf(c.env.DB, request.id, key, now());
    await c.env.PRIVATE_FILES.delete(key);
    return jsonError(
      c,
      503,
      'PERSISTENCE_FAILED',
      'The signed PDF could not be safely recorded. Please try again.',
    );
  }
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({
      type: 'nda.signed_pdf_uploaded',
      jobId: notificationJobId,
    });
  } catch {
    /* durable job recovery retries */
  }
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: request.id, signedPdfUploaded: true, scanStatus: 'clean' } }, 201);
});


export default buyers;
