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
async function encryptOtpPayload(value: string, secret: string): Promise<string> {
  // Configure OTP_ENCRYPTION_KEY as base64 for exactly 32 random bytes.
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error('Invalid OTP encryption key configuration');
  }
  if (raw.byteLength !== 32) throw new Error('Invalid OTP encryption key configuration');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value),
  );
  const b64 = (bytes: Uint8Array) =>
    btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  return JSON.stringify({
    encrypted: true,
    algorithm: 'AES-GCM',
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext)),
  });
}
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer account · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="account"><p class="eyebrow">PRIVATE BUYER AREA</p><h1>Your account</h1><p class="muted">Sign in to view saved opportunities, NDA request status and documents you are authorised to access.</p><p id="account-notice" class="notice" role="status"></p><section id="sign-in" class="panel"><h2>Sign in with email</h2><form id="request-code"><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label> <button type="submit">Send sign-in code</button></form><form id="verify-code" hidden><label>Six-digit code<br><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label> <button type="submit">Verify and sign in</button></form><p class="muted">Access is available to invited, active buyer accounts only. If you do not have an account, contact the team.</p></section><section id="buyer-content" hidden><p id="buyer-identity"></p><section id="nda-request-panel" class="panel" hidden><h2>Request confidential access</h2><p>Review the active template below. This acknowledgement is not a qualified electronic signature.</p><pre id="nda-template-content" class="nda-template-content">Loading NDA template…</pre><p class="muted" id="nda-template-version"></p><form id="nda-request-form"><label>Full legal name<br><input name="acceptanceName" minlength="2" maxlength="160" autocomplete="name" required></label> <button type="submit">Submit NDA request</button></form></section><button id="sign-out" type="button">Sign out</button><div class="grid"><section class="panel"><h2>Saved opportunities</h2><div id="saved-list">Loading…</div></section><section class="panel"><h2>NDA requests &amp; access</h2><div id="nda-list">Loading…</div></section></div></section><p><a href="/">Return to the public site</a></p></main><script src="/static/js/buyer-account.js" defer></script></body></html>`,
  ),
);

buyers.post('/api/buyer/auth/request-code', async (c) => {
  const parsed = z
    .object({
      email: z.string().trim().email().max(254),
      displayName: z.string().trim().min(2).max(120).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Enter a valid email address.');
  const email = parsed.data.email.toLowerCase();
  const throttleKey = `buyer-otp:${await digest(email)}`;
  const previous = Number.parseInt((await c.env.CACHE.get(throttleKey)) ?? '0', 10) || 0;
  if (previous >= 3)
    return c.json(
      { data: { accepted: true, message: 'If eligible, a sign-in code will be sent.' } },
      202,
    );
  await c.env.CACHE.put(throttleKey, String(previous + 1), { expirationTtl: 900 });
  const timestamp = now();
  const user = await c.env.DB.prepare(
    "SELECT id, status FROM users WHERE email = ? COLLATE NOCASE AND user_type = 'buyer' LIMIT 1",
  )
    .bind(email)
    .first<{ id: string; status: string }>();
  // Existing buyer accounts only; public sign-up is intentionally not implicit.
  if (user?.status === 'active' && c.env.OTP_ENCRYPTION_KEY) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(
      6,
      '0',
    );
    const codeId = uuid();
    await c.env.DB.prepare(
      'UPDATE buyer_login_codes SET consumed_at = ? WHERE email = ? COLLATE NOCASE AND consumed_at IS NULL',
    )
      .bind(timestamp, email)
      .run();
    await c.env.DB.prepare(
      'INSERT INTO buyer_login_codes (id, email, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    )
      .bind(
        codeId,
        email,
        await digest(`${codeId}:${code}`),
        new Date(Date.now() + 10 * 60_000).toISOString(),
        timestamp,
      )
      .run();
    const jobId = uuid();
    await c.env.DB.prepare(
      "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'buyer.login_code', ?, 'queued', 0, ?, ?, ?)",
    )
      .bind(
        jobId,
        await encryptOtpPayload(
          JSON.stringify({ email, code, expiresInMinutes: 10 }),
          c.env.OTP_ENCRYPTION_KEY,
        ),
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({ type: 'buyer.login_code', jobId });
    } catch {
      /* durable job remains queued for worker recovery */
    }
  }
  return c.json(
    { data: { accepted: true, message: 'If eligible, a sign-in code will be sent.' } },
    202,
  );
});

buyers.post('/api/buyer/auth/verify-code', async (c) => {
  const parsed = z
    .object({ email: z.string().trim().email().max(254), code: z.string().regex(/^\d{6}$/) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return jsonError(c, 422, 'VALIDATION_ERROR', 'Enter the email address and six-digit code.');
  const email = parsed.data.email.toLowerCase();
  const timestamp = now();
  const record = await c.env.DB.prepare(
    'SELECT id, code_hash AS codeHash, attempts, expires_at AS expiresAt FROM buyer_login_codes WHERE email = ? COLLATE NOCASE AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
  )
    .bind(email)
    .first<{ id: string; codeHash: string; attempts: number; expiresAt: string }>();
  if (
    !record ||
    record.expiresAt <= timestamp ||
    record.attempts >= 5 ||
    (await digest(`${record.id}:${parsed.data.code}`)) !== record.codeHash
  ) {
    if (record && record.attempts < 5)
      await c.env.DB.prepare('UPDATE buyer_login_codes SET attempts = attempts + 1 WHERE id = ?')
        .bind(record.id)
        .run();
    return jsonError(
      c,
      401,
      'INVALID_CODE',
      'The code is invalid or expired. Request a new code and try again.',
    );
  }
  const user = await c.env.DB.prepare(
    "SELECT id, email, display_name AS displayName FROM users WHERE email = ? COLLATE NOCASE AND user_type = 'buyer' AND status = 'active' LIMIT 1",
  )
    .bind(email)
    .first<Buyer>();
  if (!user)
    return jsonError(
      c,
      401,
      'INVALID_CODE',
      'The code is invalid or expired. Request a new code and try again.',
    );
  await c.env.DB.prepare('UPDATE buyer_login_codes SET consumed_at = ? WHERE id = ?')
    .bind(timestamp, record.id)
    .run();
  const sessionToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const sessionId = uuid();
  const expiry = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(sessionId, user.id, await digest(sessionToken), timestamp, timestamp, expiry),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', 'buyer.session.created', 'session', ?, ?, '{}', ?)",
    ).bind(uuid(), user.id, sessionId, c.get('requestId'), timestamp),
  ]);
  c.header(
    'Set-Cookie',
    `mayfair_buyer_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
  );
  return c.json({
    data: { id: user.id, email: user.email, displayName: user.displayName, expiresAt: expiry },
  });
});

buyers.post('/api/buyer/auth/logout', async (c) => {
  const token = readCookie(c.req.header('cookie'), 'mayfair_buyer_session');
  if (token)
    await c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    )
      .bind(now(), await digest(token))
      .run();
  c.header(
    'Set-Cookie',
    'mayfair_buyer_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
  );
  return c.json({ data: { signedOut: true } });
});

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
    "SELECT id FROM nda_requests WHERE user_id = ? AND opportunity_id = ? AND status IN ('pending','approved') LIMIT 1",
  )
    .bind(c.get('buyer').id, opportunity.id)
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
