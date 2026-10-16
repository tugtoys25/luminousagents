import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { Hono } from 'hono';
import { type AdminApp, audit, id, now } from '../shared';

const admin = new Hono<AdminApp>();

admin.get('/nda-templates/ui', requireRole('admin', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NDA templates · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>NDA template versions</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/nda-templates/ui">NDA templates</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Template content is private in R2. Legal approval is required before activation. The seeded version is explicitly a draft and must not be treated as counsel-approved.</p><form id="nda-template-form" class="buyer-provision"><label>Template name <input name="name" value="Mayfair NDA Acknowledgement" minlength="3" maxlength="160" required></label><label>Template text <textarea name="content" minlength="100" maxlength="100000" required></textarea></label><label><input type="checkbox" name="activate"> Activate immediately (only if approved by counsel)</label><button type="submit">Create version</button></form><p id="nda-template-notice" role="status"></p><ul id="nda-template-list"></ul></main><script src="/static/js/dashboard-nda-templates.js" defer></script></body></html>`,
  ),
);

admin.get('/nda-templates', requireRole('admin', 'publisher', 'super_admin'), async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash, status, created_at AS createdAt FROM nda_templates ORDER BY version DESC',
  ).all();
  return c.json({ data: rows.results ?? [] });
});

admin.post('/nda-templates', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({
      name: z.string().trim().min(3).max(160),
      content: z.string().trim().min(100).max(100000),
      activate: z.boolean().default(false),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide a template name and content (100–100,000 characters).',
        },
      },
      422,
    );
  const latest = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM nda_templates WHERE name = ?',
  )
    .bind(parsed.data.name)
    .first<{ version: number }>();
  const version = (latest?.version ?? 0) + 1;
  const templateId = id();
  const timestamp = now();
  const bytes = new TextEncoder().encode(parsed.data.content);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const r2Key = `nda/templates/${templateId}/v${version}.txt`;
  await c.env.PRIVATE_FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'private, no-store' },
    customMetadata: { contentHash: digest },
  });
  try {
    const statements = [];
    if (parsed.data.activate)
      statements.push(
        c.env.DB.prepare(
          "UPDATE nda_templates SET status = 'retired' WHERE status = 'active'",
        ).bind(),
      );
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO nda_templates (id, name, version, r2_key, content_hash, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        templateId,
        parsed.data.name,
        version,
        r2Key,
        digest,
        parsed.data.activate ? 'active' : 'draft',
        c.get('staff').id,
        timestamp,
      ),
    );
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'nda.template.created', 'nda_template', ?, ?, ?, ?)",
      ).bind(
        id(),
        c.get('staff').id,
        templateId,
        c.get('requestId'),
        JSON.stringify({
          name: parsed.data.name,
          version,
          contentHash: digest,
          activated: parsed.data.activate,
        }),
        timestamp,
      ),
    );
    await c.env.DB.batch(statements);
  } catch (error) {
    await c.env.PRIVATE_FILES.delete(r2Key);
    throw error;
  }
  return c.json(
    {
      data: {
        id: templateId,
        name: parsed.data.name,
        version,
        contentHash: digest,
        status: parsed.data.activate ? 'active' : 'draft',
      },
    },
    201,
  );
});

admin.post('/nda-templates/:id/activate', requireRole('admin', 'super_admin'), async (c) => {
  const template = await c.env.DB.prepare(
    'SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash, status FROM nda_templates WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{
      id: string;
      name: string;
      version: number;
      r2Key: string | null;
      contentHash: string;
      status: string;
    }>();
  if (!template)
    return c.json({ error: { code: 'NOT_FOUND', message: 'NDA template not found.' } }, 404);
  if (!template.r2Key)
    return c.json(
      {
        error: {
          code: 'SEED_TEMPLATE_NOT_MANAGED',
          message:
            'The bootstrap template is seeded from the repository. Create a managed version with approved content before activating a replacement.',
        },
      },
      409,
    );
  const object = await c.env.PRIVATE_FILES.get(template.r2Key);
  if (!object)
    return c.json(
      {
        error: {
          code: 'TEMPLATE_OBJECT_MISSING',
          message: 'Template content is missing from private storage.',
        },
      },
      409,
    );
  const content = await object.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== template.contentHash)
    return c.json(
      {
        error: {
          code: 'TEMPLATE_HASH_MISMATCH',
          message: 'Stored template content does not match its recorded hash.',
        },
      },
      409,
    );
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE nda_templates SET status = 'retired' WHERE status = 'active'").bind(),
    c.env.DB.prepare(
      "UPDATE nda_templates SET status = 'active' WHERE id = ? AND status IN ('draft','retired')",
    ).bind(template.id),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'nda.template.activated', 'nda_template', ?, ?, ?, ?)",
    ).bind(
      id(),
      c.get('staff').id,
      template.id,
      c.get('requestId'),
      JSON.stringify({ version: template.version, contentHash: digest }),
      timestamp,
    ),
  ]);
  return c.json({ data: { id: template.id, status: 'active', contentHash: digest } });
});

admin.get(
  '/nda-requests/ui',
  requireRole('admin', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NDA review · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>NDA request review</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review requests and record a reason. Approval grants time-limited data-room access; it is not a legal opinion or an electronic signature.</p><label>Filter <select id="status-filter"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="revoked">Revoked</option><option value="">All statuses</option></select></label><p id="notice" role="status"></p><section id="requests" aria-live="polite">Loading requests…</section></main><script src="/static/js/dashboard-nda.js" defer></script></body></html>`,
    );
  },
);

admin.get(
  '/nda-requests',
  requireRole('admin', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const status = c.req.query('status') ?? '';
    const valid = ['pending', 'approved', 'rejected', 'revoked'].includes(status) ? status : '';
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const result = await c.env.DB.prepare(
      "SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, CASE WHEN n.signed_pdf_r2_key IS NULL THEN 0 ELSE 1 END AS hasSignedPdf, n.created_at AS createdAt, u.email AS buyerEmail, u.display_name AS buyerName, o.title AS opportunityTitle FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE (? = '' OR n.status = ?) AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY n.created_at DESC LIMIT 100",
    )
      .bind(valid, valid, brokerOnly, staff.id)
      .all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.get('/nda-requests/:id/signed-pdf', requireRole('admin', 'publisher', 'super_admin'), async (c) => {
  const request = await c.env.DB.prepare('SELECT id, signed_pdf_r2_key AS r2Key, signed_pdf_sha256 AS sha256 FROM nda_requests WHERE id = ? LIMIT 1').bind(c.req.param('id')).first<{ id: string; r2Key: string | null; sha256: string | null }>();
  if (!request?.r2Key || !request.sha256) return c.json({ error: { code: 'NOT_FOUND', message: 'Signed NDA PDF not found.' } }, 404);
  const object = await c.env.PRIVATE_FILES.get(request.r2Key);
  if (!object || object.size > 10 * 1024 * 1024) return c.json({ error: { code: 'OBJECT_MISSING', message: 'Signed NDA PDF is unavailable.' } }, 404);
  const bytes = await object.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  if (hash !== request.sha256) return c.json({ error: { code: 'INTEGRITY_FAILURE', message: 'Signed NDA PDF integrity check failed.' } }, 409);
  await audit(c, 'nda.signed_pdf_downloaded', 'nda_request', request.id, { sha256: hash });
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `attachment; filename="signed-nda-${request.id}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
});

admin.patch(
  '/nda-requests/:id/review',
  requireRole('admin', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reason: z.string().trim().min(3).max(1000),
        accessDays: z.number().int().min(1).max(90).default(30),
        tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a decision and review reason.' } },
        422,
      );
    if (parsed.data.tier === 3 && c.get('staff').role !== 'super_admin') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Tier 3 access requires a super administrator.' } }, 403);
    }
    if (parsed.data.tier === 3 && parsed.data.reason.length < 20) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Tier 3 approval requires a detailed justification of at least 20 characters.' } }, 422);
    }
    const request = await c.env.DB.prepare(
      'SELECT id, user_id AS userId, opportunity_id AS opportunityId, status FROM nda_requests WHERE id = ?',
    )
      .bind(c.req.param('id'))
      .first<{ id: string; userId: string; opportunityId: string; status: string }>();
    if (!request)
      return c.json({ error: { code: 'NOT_FOUND', message: 'NDA request not found.' } }, 404);
    if (request.status !== 'pending')
      return c.json(
        { error: { code: 'CONFLICT', message: 'Only pending NDA requests can be reviewed.' } },
        409,
      );
    const timestamp = now();
    const grantId = id();
    const expiry = new Date(Date.now() + parsed.data.accessDays * 86400000).toISOString();
    const statements = [
      c.env.DB.prepare(
        'UPDATE nda_requests SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      ).bind(
        parsed.data.decision,
        parsed.data.reason,
        c.get('staff').id,
        timestamp,
        timestamp,
        request.id,
      ),
    ];
    if (parsed.data.decision === 'approved')
      statements.push(
        c.env.DB.prepare(
          'INSERT INTO access_grants (id, user_id, opportunity_id, nda_request_id, tier, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          grantId,
          request.userId,
          request.opportunityId,
          request.id,
          parsed.data.tier,
          c.get('staff').id,
          timestamp,
          expiry,
        ),
      );
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', ?, 'nda_request', ?, ?, ?, ?)",
      ).bind(
        id(),
        c.get('staff').id,
        `nda.${parsed.data.decision}`,
        request.id,
        c.get('requestId'),
        JSON.stringify({
          reason: parsed.data.reason,
          tier: parsed.data.tier,
          expiresAt: parsed.data.decision === 'approved' ? expiry : null,
        }),
        timestamp,
      ),
    );
    const decisionJobId = id();
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.decision', ?, 'queued', 0, ?, ?, ?)",
      ).bind(
        decisionJobId,
        JSON.stringify({ ndaRequestId: request.id }),
        timestamp,
        timestamp,
        timestamp,
      ),
    );
    await c.env.DB.batch(statements);
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({ type: 'nda.decision', jobId: decisionJobId });
    } catch {
      /* The durable job row is picked up by scheduled recovery. */
    }
    return c.json({
      data: {
        id: request.id,
        status: parsed.data.decision,
        accessExpiresAt: parsed.data.decision === 'approved' ? expiry : null,
      },
    });
  },
);

export default admin;
