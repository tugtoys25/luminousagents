import { requireRole } from '../../auth/staff-session';
import { getScannerMode, SCAN_SKIPPED_PROVIDER } from '../../security/malware-scanner';
import { Hono } from 'hono';
import { insertDocumentWithAudit, opportunityExists } from '../repos/documents-repo';
import { type AdminApp, id, now } from '../shared';

const admin = new Hono<AdminApp>();

function hasExpectedFileSignature(contentType: string, bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  if (contentType === 'application/pdf')
    return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  if (contentType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (contentType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  // DOCX and XLSX are ZIP containers. This checks the container signature, not its internal structure or safety.
  if (
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
    return (
      starts(0x50, 0x4b, 0x03, 0x04) ||
      starts(0x50, 0x4b, 0x05, 0x06) ||
      starts(0x50, 0x4b, 0x07, 0x08)
    );
  return false;
}

admin.post(
  '/opportunities/:id/documents',
  requireRole('admin', 'editor', 'publisher', 'super_admin'),
  async (c) => {
    if (!(await opportunityExists(c.env.DB, c.req.param('id'))))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
    const body = await c.req.parseBody();
    const upload = body.file;
    const filename =
      typeof body.filename === 'string'
        ? body.filename.trim()
        : upload instanceof File
          ? upload.name
          : '';
    const tier = Number(body.tier ?? 2);
    if (
      !(upload instanceof File) ||
      upload.size < 1 ||
      upload.size > 20 * 1024 * 1024 ||
      !filename ||
      filename.length > 180 ||
      ![1, 2, 3].includes(tier)
    )
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Upload a file up to 20 MB with a valid filename and tier.',
          },
        },
        422,
      );
    if (tier === 3 && c.get('staff').role !== 'super_admin') return c.json({ error: { code: 'FORBIDDEN', message: 'Only a super administrator may upload tier-3 documents.' } }, 403);
    const allowed = new Map([
      ['application/pdf', '.pdf'],
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ]);
    const contentType = upload.type || 'application/octet-stream';
    if (!allowed.has(contentType))
      return c.json(
        {
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'Only PDF, JPEG, PNG, DOCX and XLSX files are accepted.',
          },
        },
        415,
      );
    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (!hasExpectedFileSignature(contentType, bytes))
      return c.json(
        {
          error: {
            code: 'INVALID_FILE_SIGNATURE',
            message: 'The file contents do not match the declared file type.',
          },
        },
        415,
      );
    // eslint-disable-next-line no-control-regex
    const safeFilename = filename.replace(/[\\/\r\n\u0000-\u001f]/g, '_').slice(0, 180);
    const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digestBuffer), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const key = `opportunities/${c.req.param('id')}/documents/${crypto.randomUUID()}${allowed.get(contentType)}`;
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { originalName: safeFilename, uploadedBy: c.get('staff').id },
    });
    const documentId = id();
    const timestamp = now();
    const scanSkipped = (await getScannerMode(c.env)) === 'disabled';
    try {
      await insertDocumentWithAudit(c.env.DB, {
        id: documentId,
        opportunityId: c.req.param('id'),
        r2Key: key,
        filename: safeFilename,
        contentType,
        byteSize: upload.size,
        tier,
        uploadedBy: c.get('staff').id,
        timestamp,
        sha256,
        scanSkipped,
        skipProvider: SCAN_SKIPPED_PROVIDER,
        auditId: id(),
        requestId: c.get('requestId'),
      });
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    return c.json(
      {
        data: {
          id: documentId,
          filename: safeFilename,
          contentType,
          byteSize: upload.size,
          tier,
          createdAt: timestamp,
          scanStatus: scanSkipped ? 'clean' : 'pending',
          scanSkipped,
        },
      },
      201,
    );
  },
);

export default admin;
