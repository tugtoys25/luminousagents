import { requireRole } from '../../auth/staff-session';
import { requireRecentMfa } from '../../auth/step-up';
import {
  getScannerMode,
  SCAN_SKIPPED_PROVIDER,
  SCANNER_MODE_KEY,
  ScannerError,
  scanR2Document,
} from '../../security/malware-scanner';
import { z } from 'zod';
import { Hono } from 'hono';
import {
  changeScannerMode,
  countPendingDocuments,
  deleteDocumentRow,
  findDocumentForDelete,
  findDocumentForReview,
  findDocumentForScan,
  listDocuments,
  loadSavedScan,
  recordScanResult,
  setScanStatusManually,
  settingUpdatedAt,
} from '../repos/documents-repo';
import { type AdminApp, audit, id, now } from '../shared';

const admin = new Hono<AdminApp>();

admin.get('/documents/ui', requireRole('admin', 'editor', 'publisher', 'super_admin'), (c) => c.html(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data room documents · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">CONFIDENTIAL STAFF WORKSPACE</p><h1>Data room documents</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/documents/ui" aria-current="page">Data room documents</a><a href="/dashboard/audit/ui">Audit log</a></nav><p class="muted">Documents are stored in private R2. They are never publicly served. Files remain unavailable to buyers until a trusted scanner verifies the exact stored bytes as clean.</p><section id="scanner-panel" class="flow-card"><h2>Malware scanner</h2><p id="scanner-state" role="status" aria-live="polite">Loading scanner status…</p><form id="scanner-form" class="flow" hidden><label>Reason for this change<input name="reason" minlength="5" maxlength="500" required placeholder="e.g. Scanner server is not ready yet"></label><label id="scanner-release-label"><input type="checkbox" name="releasePending"> Also release documents already waiting for a scan</label><button type="submit" id="scanner-toggle">Switch scanner off</button><p id="scanner-notice" role="status" aria-live="polite"></p></form></section><form id="document-upload" class="flow"><label>Opportunity <select name="opportunityId" id="document-opportunity" required><option value="">Loading opportunities…</option></select></label><label>Document tier <select name="tier"><option value="1">Tier 1 — basic confidential</option><option value="2" selected>Tier 2 — confidential</option><option value="3">Tier 3 — highest confidentiality (super administrator only)</option></select></label><label>File (PDF, JPEG, PNG, DOCX or XLSX; max 20 MiB)<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><button type="submit">Upload private document</button><p id="document-upload-notice" role="status" aria-live="polite"></p></form><hr><label>Filter by opportunity <select id="document-filter"><option value="">All opportunities</option></select></label><p id="document-notice" role="status" aria-live="polite">Loading documents…</p><div class="overflow-x-auto"><table><thead><tr><th>Document</th><th>Opportunity</th><th>Tier</th><th>Scan</th><th>Created</th><th>Actions</th></tr></thead><tbody id="document-rows"></tbody></table></div></main><script src="/static/js/dashboard-documents.js" defer></script></body></html>`
));

admin.get('/documents', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const opportunityId = (c.req.query('opportunityId') ?? '').trim().slice(0, 100);
  const rows = await listDocuments(c.env.DB, opportunityId);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: rows, limit: 200 });
});

admin.get(
  '/scanner-settings',
  requireRole('admin', 'editor', 'publisher', 'super_admin'),
  async (c) => {
    const updatedAt = await settingUpdatedAt(c.env.DB, SCANNER_MODE_KEY);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      data: {
        mode: await getScannerMode(c.env),
        scannerConfigured: Boolean(
          c.env.MALWARE_SCANNER_API_URL &&
            c.env.MALWARE_SCANNER_API_TOKEN &&
            c.env.MALWARE_SCANNER_SIGNING_SECRET,
        ),
        updatedAt,
      },
    });
  },
);

admin.put('/scanner-settings', requireRole('admin', 'super_admin'), requireRecentMfa('/dashboard'), async (c) => {
  const parsed = z
    .object({
      mode: z.enum(['enforced', 'disabled']),
      reason: z.string().trim().min(5).max(500),
      releasePending: z.boolean().optional().default(false),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Choose a scanner mode and give a reason of at least 5 characters.',
        },
      },
      422,
    );
  const staff = c.get('staff');
  const previous = await getScannerMode(c.env);
  const timestamp = now();
  const releasePending = parsed.data.mode === 'disabled' && parsed.data.releasePending;
  const pendingTotal = releasePending ? await countPendingDocuments(c.env.DB) : 0;
  await changeScannerMode(c.env.DB, {
    settingKey: SCANNER_MODE_KEY,
    mode: parsed.data.mode,
    staffId: staff.id,
    timestamp,
    releasePending,
    skipProvider: SCAN_SKIPPED_PROVIDER,
    auditId: id(),
    requestId: c.get('requestId'),
    auditDetails: {
      from: previous,
      to: parsed.data.mode,
      reason: parsed.data.reason,
      releasedPending: pendingTotal,
    },
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    data: {
      mode: parsed.data.mode,
      updatedAt: timestamp,
      releasedPending: pendingTotal,
    },
  });
});

admin.post('/documents/:id/scan', requireRole('admin', 'super_admin'), async (c) => {
  const document = await findDocumentForScan(c.env.DB, c.req.param('id'));
  if (!document)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
  if (document.scanStatus !== 'pending')
    return c.json(
      { error: { code: 'CONFLICT', message: 'Only pending documents can be scanned.' } },
      409,
    );
  let result;
  try {
    result = await scanR2Document(c.env, {
      documentId: document.id,
      r2Key: document.r2Key,
      contentType: document.contentType,
      expectedSha256: document.sha256,
    });
  } catch (error) {
    const code = error instanceof ScannerError ? error.code : 'UNAVAILABLE';
    const status =
      code === 'NOT_CONFIGURED'
        ? 503
        : code === 'OBJECT_MISSING' || code === 'OBJECT_CHANGED'
          ? 409
          : 503;
    return c.json(
      {
        error: {
          code: `SCANNER_${code}`,
          message:
            code === 'OBJECT_CHANGED'
              ? 'Stored file bytes do not match the recorded digest; the file remains unavailable.'
              : code === 'OBJECT_MISSING'
                ? 'Stored file is missing; the file remains unavailable.'
                : 'A verified malware scan could not be completed; the file remains unavailable.',
        },
      },
      status,
    );
  }
  const scanStatus = result.verdict === 'clean' ? 'clean' : 'rejected';
  const timestamp = now();
  const auditDetailsJson = JSON.stringify({
    provider: result.provider,
    reference: result.reference,
    verdict: result.verdict,
    sha256: result.sha256,
    scannedAt: result.scannedAt,
    engineVersion: result.engineVersion,
    opportunityId: document.opportunityId,
    scanSkipped: result.provider === SCAN_SKIPPED_PROVIDER,
  });
  try {
    await recordScanResult(c.env.DB, {
      documentId: document.id,
      expectedSha256: document.sha256,
      scanStatus,
      provider: result.provider,
      reference: result.reference,
      verdict: result.verdict,
      sha256: result.sha256,
      scannedAt: result.scannedAt,
      engineVersion: result.engineVersion,
      auditId: id(),
      actorId: c.get('staff').id,
      requestId: c.get('requestId'),
      auditDetailsJson,
      timestamp,
    });
  } catch {
    return c.json(
      {
        error: {
          code: 'SCAN_AUDIT_FAILED',
          message:
            'The scan result could not be recorded atomically; the file remains unavailable.',
        },
      },
      500,
    );
  }
  const saved = await loadSavedScan(c.env.DB, document.id);
  if (!saved || saved.scanJobId !== result.reference || saved.scanStatus !== scanStatus)
    return c.json(
      {
        error: {
          code: 'SCAN_STATE_CONFLICT',
          message: 'The document state changed during scanning; review is required.',
        },
      },
      409,
    );
  return c.json({
    data: {
      id: document.id,
      scanStatus,
      provider: result.provider,
      scanJobId: result.reference,
      sha256: result.sha256,
      scannedAt: result.scannedAt,
      engineVersion: result.engineVersion,
    },
  });
});

admin.patch('/documents/:id/scan-status', requireRole('admin', 'super_admin'), requireRecentMfa('/dashboard'), async (c) => {
  const parsed = z
    .object({
      status: z.enum(['clean', 'rejected']),
      reason: z.string().trim().min(5).max(1000),
      scannerReference: z.string().trim().min(1).max(300).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Provide a status and a review reason.' } },
      422,
    );
  if (parsed.data.status === 'clean')
    return c.json(
      {
        error: {
          code: 'VERIFIED_SCAN_REQUIRED',
          message:
            'Use POST /dashboard/documents/:id/scan to scan the exact stored object and verify the signed provider result.',
        },
      },
      409,
    );
  const document = await findDocumentForReview(c.env.DB, c.req.param('id'));
  if (!document)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
  const timestamp = now();
  await setScanStatusManually(c.env.DB, {
    documentId: document.id,
    status: parsed.data.status,
    auditId: id(),
    actorId: c.get('staff').id,
    requestId: c.get('requestId'),
    detailsJson: JSON.stringify({
      reason: parsed.data.reason,
      scannerReference: parsed.data.scannerReference ?? null,
      sha256: document.sha256,
      opportunityId: document.opportunityId,
    }),
    timestamp,
  });
  return c.json({
    data: { id: document.id, scanStatus: parsed.data.status, updatedAt: timestamp },
  });
});

admin.delete('/documents/:id', requireRole('admin', 'publisher', 'super_admin'), requireRecentMfa('/dashboard'), async (c) => {
  const doc = await findDocumentForDelete(c.env.DB, c.req.param('id'));
  if (!doc) return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
  await deleteDocumentRow(c.env.DB, doc.id);
  await c.env.PRIVATE_FILES.delete(doc.r2Key);
  await audit(c, 'document.deleted', 'document', doc.id, { opportunityId: doc.opportunityId });
  return c.json({ data: { deleted: true } });
});

export default admin;
