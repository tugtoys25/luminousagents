import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { requireRecentMfa } from '../../auth/step-up';
import { getScannerMode, SCAN_SKIPPED_PROVIDER, ScannerError, scanR2Document } from '../../security/malware-scanner';
import { findAuthority } from '../../seller/authority-repo';
import { EVIDENCE_MAX_BYTES, evidenceKey, safeFilename, sha256Hex, validateEvidenceFile } from '../../seller/evidence-files';
import { runEvidencePurge } from '../../seller/evidence-purge';
import { findEvidence, insertEvidence, logDownload, recordScan, requestPurge, retireEvidence } from '../../seller/evidence-repo';
import { AUTHORITY_REF_PATTERN } from '../../seller/reference';
import { sellerScopeOf } from '../../seller/seller-access';
import { evidenceDeleteSchema, evidenceReasonSchema } from '../../seller/seller-schemas';
import { jsonError, readJson, type Ctx } from '../../seller/staff-access';
import { type AdminApp, authorityReviewRoles, id, now, sellerEvidenceDeleteRoles, sellerEvidenceDownloadRoles, sellerEvidenceRoles } from '../shared';

const admin = new Hono<AdminApp>();
const UUID = /^[0-9a-f-]{36}$/;

async function loadEvidence(c: Ctx) {
  const evidenceId = c.req.param('evidenceId') ?? '';
  return UUID.test(evidenceId) ? findEvidence(c.env.DB, evidenceId, sellerScopeOf(c)) : null;
}

/** Attach a file to an authority record. It starts unavailable (pending scan) unless the administrator has switched the scanner off. */
admin.post('/authority/:ref/evidence', requireRole(...sellerEvidenceRoles), async (c) => {
  if (Number.parseInt(c.req.header('content-length') ?? '0', 10) > EVIDENCE_MAX_BYTES + 1024 * 1024) return jsonError(c, 422, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.');
  const ref = c.req.param('ref') ?? '';
  const record = AUTHORITY_REF_PATTERN.test(ref) ? await findAuthority(c.env.DB, ref, sellerScopeOf(c)) : null;
  if (!record) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  if (record.status === 'REVOKED') return jsonError(c, 409, 'INVALID_STATE', 'Evidence cannot be added to a revoked record.');
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.['file'];
  if (!(file instanceof File)) return jsonError(c, 422, 'VALIDATION_ERROR', 'Choose a file to upload.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = validateEvidenceFile(file.name, file.type, bytes);
  if (!checked.ok) return jsonError(c, 422, 'VALIDATION_ERROR', checked.message);
  const evidenceId = id();
  const key = evidenceKey(record.id, evidenceId, checked.extension);
  const skipped = (await getScannerMode(c.env)) === 'disabled';
  await c.env.PRIVATE_FILES.put(key, bytes, { httpMetadata: { contentType: checked.contentType } });
  let ok = false;
  try {
    ok = await insertEvidence(c.env.DB, {
      id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), evidenceId, recordId: record.id, recordReference: record.reference, sellerId: record.sellerId, sellerReference: record.sellerReference, r2Key: key, filename: safeFilename(file.name),
      contentType: checked.contentType, byteSize: bytes.byteLength, sha256: await sha256Hex(bytes), scanStatus: skipped ? 'clean' : 'pending', scanProvider: skipped ? SCAN_SKIPPED_PROVIDER : null, scanSkipped: skipped, logId: id(), auditId: id(),
    });
  } finally {
    if (!ok) await c.env.PRIVATE_FILES.delete(key).catch(() => undefined); // never leave an object without a row
  }
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'The file could not be attached (record revoked, or the limit of 10 active files per record is reached).');
  return c.json({ data: { id: evidenceId, scanStatus: skipped ? 'clean' : 'pending', scanSkipped: skipped } }, 201);
});

admin.post('/authority-evidence/:evidenceId/scan', requireRole(...authorityReviewRoles), async (c) => {
  const evidence = await loadEvidence(c);
  if (!evidence || !evidence.r2Key) return jsonError(c, 404, 'NOT_FOUND', 'Evidence not found.');
  if (evidence.scanStatus !== 'pending') return jsonError(c, 409, 'INVALID_STATE', 'This file has already been scanned.');
  let result;
  try {
    result = await scanR2Document(c.env, { documentId: evidence.id, r2Key: evidence.r2Key, contentType: evidence.contentType, expectedSha256: evidence.sha256 });
  } catch (error) {
    const code = error instanceof ScannerError ? error.code : 'UNAVAILABLE';
    return jsonError(c, 409, `SCANNER_${code}`, code === 'OBJECT_CHANGED' ? 'The stored bytes no longer match the recorded digest; the file stays unavailable.' : 'A verified scan could not be completed; the file stays unavailable.');
  }
  const ok = await recordScan(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), evidence, verdict: result.verdict === 'clean' ? 'clean' : 'rejected', provider: result.provider, reference: result.reference, skipped: result.provider === SCAN_SKIPPED_PROVIDER, scannedAt: result.scannedAt, logId: id(), auditId: id() });
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'The file changed while it was being scanned.');
  return c.json({ data: { id: evidence.id, scanStatus: result.verdict === 'clean' ? 'clean' : 'rejected' } });
});

/**
 * Streams the file through the authenticated Worker (no public or pre-signed URL exists). Only reviewers; recent MFA; only scanned-clean, not-purged files;
 * the access-log row is written first and a failure to write it means no bytes are returned.
 */
admin.get('/authority-evidence/:evidenceId/download', requireRole(...sellerEvidenceDownloadRoles), requireRecentMfa('/dashboard/sellers/ui'), async (c) => {
  const evidence = await loadEvidence(c);
  if (!evidence || !evidence.r2Key || evidence.purgedAt || evidence.purgePending) return jsonError(c, 404, 'NOT_FOUND', 'Evidence not found.');
  if (evidence.scanStatus !== 'clean') return jsonError(c, 409, 'NOT_AVAILABLE', 'This file is not available: it has not been scanned clean.');
  try {
    await logDownload(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), evidence, logId: id(), auditId: id() });
  } catch {
    return jsonError(c, 409, 'NOT_AVAILABLE', 'The download could not be recorded, so it was not provided.');
  }
  const object = await c.env.PRIVATE_FILES.get(evidence.r2Key);
  if (!object || object.size !== evidence.byteSize) return jsonError(c, 404, 'NOT_FOUND', 'Evidence not found.');
  const ascii = evidence.filename.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 100) || 'evidence';
  return new Response(object.body, {
    headers: {
      'Content-Type': evidence.contentType,
      'Content-Length': String(evidence.byteSize),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(evidence.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
});

admin.post('/authority-evidence/:evidenceId/retire', requireRole(...authorityReviewRoles), async (c) => {
  const parsed = evidenceReasonSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Give a reason (5+ characters) and confirm.');
  const evidence = await loadEvidence(c);
  if (!evidence) return jsonError(c, 404, 'NOT_FOUND', 'Evidence not found.');
  if (!(await retireEvidence(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), evidence, reason: parsed.data.reason, logId: id(), auditId: id() }))) return jsonError(c, 409, 'INVALID_STATE', 'Already retired.');
  return c.json({ data: { id: evidence.id, status: 'RETIRED' } });
});

/** Permanent removal of the bytes. The metadata row and access log stay. */
admin.post('/authority-evidence/:evidenceId/delete', requireRole(...sellerEvidenceDeleteRoles), requireRecentMfa('/dashboard/sellers/ui'), async (c) => {
  const parsed = evidenceDeleteSchema.safeParse(await readJson(c));
  const evidence = await loadEvidence(c);
  if (!parsed.success || !evidence || parsed.data.confirmId !== evidence.id) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Give a reason, repeat the evidence id exactly, and confirm.');
  if (!(await requestPurge(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), evidence, reason: parsed.data.reason, logId: id(), auditId: id() }))) return jsonError(c, 409, 'INVALID_STATE', 'Already deleted or pending deletion.');
  await runEvidencePurge(c.env).catch(() => undefined);
  return c.json({ data: { id: evidence.id, deleted: true } });
});

export default admin;
