import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env';

type Buyer = { id: string; email: string; displayName: string; status: string };
type BuyerApp = { Bindings: Env; Variables: { requestId: string; buyer: Buyer } };
const buyers = new Hono<BuyerApp>();
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const jsonError = (
  c: Context<BuyerApp>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) => c.json({ error: { code, message }, requestId: c.get('requestId') }, status);
async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, '0')).join('');
}
function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
async function buyerAuth(c: Context<BuyerApp>): Promise<Buyer | Response> {
  const token = readCookie(c.req.header('cookie'), 'mayfair_buyer_session');
  if (!token) return jsonError(c, 401, 'UNAUTHENTICATED', 'Buyer sign-in required.');
  const tokenHash = await digest(token);
  const row = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS displayName, u.status, s.id AS sessionId FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'buyer' AND u.status = 'active' LIMIT 1",
  )
    .bind(tokenHash, now())
    .first<Buyer & { sessionId: string }>();
  if (!row) return jsonError(c, 401, 'UNAUTHENTICATED', 'Buyer session is invalid or expired.');
  await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now(), row.sessionId)
    .run();
  const { sessionId: _sessionId, ...buyer } = row;
  return buyer;
}
async function requireBuyer(c: Context<BuyerApp>, next: () => Promise<void>) {
  const identity = await buyerAuth(c);
  if (identity instanceof Response) return identity;
  c.set('buyer', identity);
  await next();
}
async function audit(
  c: Context<BuyerApp>,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      uuid(),
      c.get('buyer').id,
      action,
      entityType,
      entityId,
      c.get('requestId'),
      JSON.stringify(details),
      now(),
    )
    .run();
}

buyers.get('/account', async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer account · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="account"><p class="eyebrow">PRIVATE BUYER AREA</p><h1>Your account</h1><p class="muted">Sign in to view saved opportunities, NDA request status and documents you are authorised to access.</p><p id="account-notice" class="notice" role="status"></p><section id="sign-in" class="panel"><h2>Sign in</h2><form id="sign-in-form" data-auth-form data-endpoint="/api/buyer/auth/login" data-success-reload><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label> <label>Password<br><input name="password" type="password" autocomplete="current-password" maxlength="200" required></label> <button type="submit">Sign in</button><p class="notice" role="status" aria-live="polite"></p></form><p class="muted"><a href="/forgot-password">Forgot your password?</a></p><p class="muted">Access is available to approved, active buyer accounts only. New buyers can <a href="/register">register for review</a>; registration does not automatically grant confidential access.</p></section><section id="buyer-content" hidden><p id="buyer-identity"></p><section id="nda-request-panel" class="panel" hidden><h2>Request confidential access</h2><p>Review the active template below. This acknowledgement is not a qualified electronic signature.</p><pre id="nda-template-content" class="nda-template-content">Loading NDA template…</pre><p class="muted" id="nda-template-version"></p><form id="nda-request-form"><label>Full legal name<br><input name="acceptanceName" minlength="2" maxlength="160" autocomplete="name" required></label> <button type="submit">Submit NDA request</button></form></section><p><a href="/account/change-password">Change password</a> · <button id="sign-out" type="button">Sign out</button></p><div class="grid"><section class="panel"><h2>Saved opportunities</h2><div id="saved-list">Loading…</div></section><section class="panel"><h2>NDA requests &amp; access</h2><div id="nda-list">Loading…</div></section></div></section><p><a href="/">Return to the public site</a></p></main><script src="/static/js/auth-forms.js" defer></script><script src="/static/js/buyer-account.js" defer></script></body></html>`,
  ),
);

buyers.get('/api/buyer/me', requireBuyer, async (c) => c.json({ data: c.get('buyer') }));
buyers.get('/api/buyer/opportunities', requireBuyer, async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT o.id, o.slug, o.title, o.country, o.opportunity_type AS opportunityType, o.summary, s.created_at AS savedAt FROM saved_opportunities s JOIN opportunities o ON o.id = s.opportunity_id WHERE s.user_id = ? AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 ORDER BY s.created_at DESC",
  )
    .bind(c.get('buyer').id)
    .all();
  return c.json({ data: result.results ?? [] });
});
buyers.post('/api/buyer/opportunities/:id/save', requireBuyer, async (c) => {
  const opp = await c.env.DB.prepare(
    "SELECT id FROM opportunities WHERE id = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1",
  )
    .bind(c.req.param('id'))
    .first();
  if (!opp) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO saved_opportunities (user_id, opportunity_id, created_at) VALUES (?, ?, ?)',
  )
    .bind(c.get('buyer').id, c.req.param('id'), now())
    .run();
  await audit(c, 'opportunity.saved', 'opportunity', c.req.param('id') ?? '');
  return c.json({ data: { saved: true } }, 201);
});
buyers.delete('/api/buyer/opportunities/:id/save', requireBuyer, async (c) => {
  await c.env.DB.prepare('DELETE FROM saved_opportunities WHERE user_id = ? AND opportunity_id = ?')
    .bind(c.get('buyer').id, c.req.param('id'))
    .run();
  await audit(c, 'opportunity.unsaved', 'opportunity', c.req.param('id') ?? '');
  return c.json({ data: { saved: false } });
});

buyers.get('/api/buyer/nda-requests', requireBuyer, async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, n.created_at AS createdAt, o.id AS opportunityId, o.slug AS opportunitySlug, o.title AS opportunityTitle, g.id AS grantId, g.tier AS accessTier, g.expires_at AS accessExpiresAt, g.revoked_at AS accessRevokedAt FROM nda_requests n JOIN opportunities o ON o.id = n.opportunity_id LEFT JOIN access_grants g ON g.nda_request_id = n.id AND g.user_id = n.user_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100',
  )
    .bind(c.get('buyer').id)
    .all();
  return c.json({ data: result.results ?? [] });
});

buyers.get('/api/buyer/opportunities/:id/documents', requireBuyer, async (c) => {
  const opp = await c.env.DB.prepare(
    "SELECT id FROM opportunities WHERE id = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1",
  )
    .bind(c.req.param('id'))
    .first();
  if (!opp) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const grant = await c.env.DB.prepare(
    'SELECT id, tier FROM access_grants WHERE user_id = ? AND opportunity_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
  )
    .bind(c.get('buyer').id, c.req.param('id'), now())
    .first<{ id: string; tier: number }>();
  if (!grant)
    return jsonError(c, 403, 'ACCESS_NOT_GRANTED', 'Approved NDA and active access are required.');
  const result = await c.env.DB.prepare(
    "SELECT id, filename, content_type AS contentType, byte_size AS byteSize, tier, created_at AS createdAt FROM documents WHERE opportunity_id = ? AND tier <= ? AND scan_status = 'clean' ORDER BY created_at DESC",
  )
    .bind(c.req.param('id'), grant.tier)
    .all();
  return c.json({ data: result.results ?? [] });
});

buyers.get('/api/buyer/documents/:documentId/download', requireBuyer, async (c) => {
  const doc = await c.env.DB.prepare(
    "SELECT d.id, d.opportunity_id AS opportunityId, d.r2_key AS r2Key, d.filename, d.content_type AS contentType, d.tier FROM documents d JOIN opportunities o ON o.id = d.opportunity_id WHERE d.id = ? AND d.scan_status = 'clean' AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1",
  )
    .bind(c.req.param('documentId'))
    .first<{
      id: string;
      opportunityId: string;
      r2Key: string;
      filename: string;
      contentType: string;
      tier: number;
    }>();
  if (!doc) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  const grant = await c.env.DB.prepare(
    'SELECT id, tier FROM access_grants WHERE user_id = ? AND opportunity_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
  )
    .bind(c.get('buyer').id, doc.opportunityId, now())
    .first<{ id: string; tier: number }>();
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

buyers.get('/api/buyer/nda-template', requireBuyer, async (c) => {
  const template = await c.env.DB.prepare(
    "SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash FROM nda_templates WHERE status = 'active' ORDER BY version DESC LIMIT 1",
  ).first<{
    id: string;
    name: string;
    version: number;
    r2Key: string | null;
    contentHash: string;
  }>();
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
    content = `CONFIDENTIALITY AND NON-DISCLOSURE ACKNOWLEDGEMENT\n\nVersion 1 — draft template for legal review\n\nThe recipient acknowledges that information provided in connection with an opportunity may be confidential, may be incomplete, and must not be copied, disclosed, published, or used except to evaluate the opportunity and as authorised in writing. The recipient must restrict access to appropriate professional advisers who are bound by confidentiality obligations, protect materials using reasonable safeguards, and promptly notify the disclosing party of unauthorised access or disclosure. On request, the recipient must stop using the materials and return or securely destroy copies, subject to lawful record-retention duties. No representation, warranty, offer, or commitment is made by this acknowledgement. Any transaction remains subject to definitive written agreements, due diligence, applicable law, and any required regulatory approvals.\n\nBy entering their legal name and submitting an access request, the recipient records an acknowledgement of this template. This workflow is not represented as a qualified electronic signature and does not replace a counsel-approved agreement or signature process. The parties, governing law, remedies, data protection terms, permitted recipients, retention period, and transaction-specific restrictions must be completed or approved by qualified counsel before production use.\n`;
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
  const opportunity = await c.env.DB.prepare(
    "SELECT id FROM opportunities WHERE slug = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1",
  )
    .bind(c.req.param('slug'))
    .first<{ id: string }>();
  if (!opportunity) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const template = parsed.data.templateId
    ? await c.env.DB.prepare(
        "SELECT id, content_hash AS contentHash FROM nda_templates WHERE id = ? AND status = 'active'",
      )
        .bind(parsed.data.templateId)
        .first<{ id: string; contentHash: string }>()
    : await c.env.DB.prepare(
        "SELECT id, content_hash AS contentHash FROM nda_templates WHERE status = 'active' ORDER BY version DESC LIMIT 1",
      ).first<{ id: string; contentHash: string }>();
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
  const previous = await c.env.DB.prepare(
    "SELECT n.id FROM nda_requests n WHERE n.user_id = ? AND n.opportunity_id = ? AND (n.status = 'pending' OR (n.status = 'approved' AND EXISTS (SELECT 1 FROM access_grants g WHERE g.nda_request_id = n.id AND g.revoked_at IS NULL AND g.expires_at > ?))) LIMIT 1",
  )
    .bind(c.get('buyer').id, opportunity.id, now())
    .first();
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
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO nda_requests (id, user_id, opportunity_id, template_id, status, acceptance_name, accepted_at, accepted_ip_hash, nda_template_hash, review_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, '', ?, ?)",
    ).bind(
      requestId,
      c.get('buyer').id,
      opportunity.id,
      template.id,
      parsed.data.acceptanceName,
      timestamp,
      acceptedIpHash,
      template.contentHash,
      timestamp,
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', 'nda.requested', 'nda_request', ?, ?, ?, ?)",
    ).bind(
      uuid(),
      c.get('buyer').id,
      requestId,
      c.get('requestId'),
      JSON.stringify({
        opportunityId: opportunity.id,
        templateId: template.id,
        templateHash: template.contentHash,
      }),
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.review_requested', ?, 'queued', 0, ?, ?, ?)",
    ).bind(
      notificationJobId,
      JSON.stringify({ ndaRequestId: requestId }),
      timestamp,
      timestamp,
      timestamp,
    ),
  ]);
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

export default buyers;
