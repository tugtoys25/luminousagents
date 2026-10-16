import { Hono } from 'hono';
import type { Env } from '../env';
import { STATIC_PAGES, staticPageSlug } from './static-pages';

const managed = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
async function setting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT value_json AS value FROM platform_settings WHERE setting_key=?',
  )
    .bind(key)
    .first<{ value: string }>();
  if (!row) return '';
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === 'string' ? parsed.trim().slice(0, 100) : '';
  } catch {
    return '';
  }
}
managed.get('/pages/:slug', async (c) => {
  const slug = c.req.param('slug');
  // Built-in pages keep their own address; /pages/<builtin-slug> is never a second URL for them.
  const builtInPath = STATIC_PAGES.find(([path]) => staticPageSlug(path) === slug)?.[0];
  if (builtInPath) return c.redirect(builtInPath, 301);
  const page = await c.env.DB.prepare(
    "SELECT title,description,body_markdown AS bodyMarkdown,seo_title AS seoTitle,seo_description AS seoDescription FROM managed_pages WHERE slug=? AND status='published' LIMIT 1",
  )
    .bind(slug)
    .first<{
      title: string;
      description: string;
      bodyMarkdown: string;
      seoTitle: string;
      seoDescription: string;
    }>();
  if (!page) return c.notFound();
  const name = (await setting(c.env, 'site_name')) || 'Casinos of Mayfair';
  const body = escapeHtml(page.bodyMarkdown).replace(/\r?\n/g, '<br>');
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.seoTitle || page.title)} | ${escapeHtml(name)}</title><meta name="description" content="${escapeHtml(page.seoDescription || page.description)}"><link rel="stylesheet" href="/static/css/site.css"></head><body><header class="site-header"><div class="container header-inner"><a class="brand" href="/"><span class="brand-mark">M</span><span class="brand-copy"><strong>${escapeHtml(name)}</strong></span></a><nav class="main-nav"><a href="/casinos-for-sale">Opportunities</a><a href="/contact">Contact</a></nav></div></header><main id="main"><section class="page-hero"><div class="container"><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.description)}</p></div></section><section class="section"><div class="container content-narrow"><p>${body}</p><a class="button button-dark" href="/contact">Contact our team</a></div></section></main></body></html>`,
  );
});
managed.get('/forms/:slug', async (c) => {
  const slug = c.req.param('slug');
  const form = await c.env.DB.prepare(
    "SELECT id,title,description,fields_json AS fieldsJson FROM managed_forms WHERE slug=? AND status='published' LIMIT 1",
  )
    .bind(slug)
    .first<{ id: string; title: string; description: string; fieldsJson: string }>();
  if (!form) return c.notFound();
  {
    const clientIp = c.req.header('cf-connecting-ip');
    const rateKey = clientIp
      ? Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(`${c.env.IP_HASH_SECRET ?? ''}:${clientIp}`),
            ),
          ),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('')
      : 'unknown';
    const key = `form-rate:${slug}:${rateKey}`;
    const count = Number.parseInt((await c.env.CACHE.get(key)) ?? '0', 10) || 0;
    if (count >= 8)
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Please wait before sending another request.' } },
        429,
      );
    await c.env.CACHE.put(key, String(count + 1), { expirationTtl: 600 });
  }
  let fields: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
  try {
    fields = JSON.parse(form.fieldsJson);
  } catch {
    return c.text('Form is unavailable.', 503);
  }
  const opportunity = c.req.query('opportunity') ?? '';
  const controls = fields
    .map((f) => {
      const req = f.required ? 'required' : '';
      if (f.type === 'textarea')
        return `<label>${escapeHtml(f.label)}<textarea name="${escapeHtml(f.name)}" maxlength="5000" ${req}></textarea></label>`;
      if (f.type === 'select')
        return `<label>${escapeHtml(f.label)}<select name="${escapeHtml(f.name)}" ${req}><option value="">Select…</option>${(f.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select></label>`;
      return `<label>${escapeHtml(f.label)}<input name="${escapeHtml(f.name)}" type="${f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'}" maxlength="254" ${req}></label>`;
    })
    .join('');
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(form.title)} · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"></head><body><main class="managed-form"><h1>${escapeHtml(form.title)}</h1><p>${escapeHtml(form.description)}</p><form id="managed-public-form" data-turnstile>${opportunity ? `<input type="hidden" name="opportunity" value="${escapeHtml(opportunity)}">` : ''}${controls}<label><span><input type="checkbox" name="consent" required> I agree that the team may use these details to respond to this request. Read the <a href="/legal/privacy">privacy notice</a>.</span></label><label class="honeypot">Website <input name="website" tabindex="-1" autocomplete="off"></label><button type="submit">Submit request</button><p id="form-notice" role="status" aria-live="polite"></p></form></main><script src="/static/js/turnstile-forms.js" defer></script><script src="/static/js/managed-form.js" data-form-slug="${escapeHtml(slug)}" defer></script></body></html>`,
  );
});
managed.post('/api/forms/:slug/submit', async (c) => {
  const slug = c.req.param('slug');
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return c.json({ error: { code: 'INVALID_FORM', message: 'Check the form fields.' } }, 422);
  if (typeof raw.website === 'string' && raw.website.trim())
    return c.json({ data: { accepted: true } }, 202);
  const form = await c.env.DB.prepare(
    "SELECT id,title,description,fields_json AS fieldsJson,notification_enabled AS notificationEnabled FROM managed_forms WHERE slug=? AND status='published' LIMIT 1",
  )
    .bind(slug)
    .first<{
      id: string;
      title: string;
      description: string;
      fieldsJson: string;
      notificationEnabled: number;
    }>();
  if (!form) return c.notFound();
  let fields: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
  try {
    fields = JSON.parse(form.fieldsJson);
  } catch {
    return c.json({ error: { code: 'FORM_UNAVAILABLE', message: 'Form is unavailable.' } }, 503);
  }
  const data: Record<string, string> = {};
  for (const field of fields) {
    const value = raw[field.name];
    if (typeof value !== 'string' || value.length > 5000 || (field.required && !value.trim()))
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `Check the ${field.label} field.` } },
        422,
      );
    if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `Check the ${field.label} field.` } },
        422,
      );
    if (field.type === 'select' && value && !(field.options ?? []).includes(value))
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `Choose a valid ${field.label}.` } },
        422,
      );
    data[field.name] = value.trim();
  }
  if (!['on', 'true', '1'].includes(String(raw.consent ?? '')))
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: 'Consent is required.' } }, 422);
  const opportunitySlug = typeof raw.opportunity === 'string' ? raw.opportunity.slice(0, 120) : '';
  let opportunityId: string | null = null;
  if (opportunitySlug) {
    const op = await c.env.DB.prepare(
      "SELECT id,title FROM opportunities WHERE slug=? AND lifecycle='published' AND content_review_status='approved' AND public_visibility=1 LIMIT 1",
    )
      .bind(opportunitySlug)
      .first<{ id: string; title: string }>();
    if (op) {
      opportunityId = op.id;
    }
  }
  const id = uuid(),
    timestamp = now(),
    ip = c.req.header('cf-connecting-ip') ?? '';
  let ipHash: string | null = null;
  if (ip && c.env.IP_HASH_SECRET) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(c.env.IP_HASH_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
    ipHash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  await c.env.DB.prepare(
    'INSERT INTO managed_form_submissions (id,form_id,opportunity_id,data_json,consent_at,ip_hash,created_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(id, form.id, opportunityId, JSON.stringify(data), timestamp, ipHash, timestamp)
    .run();
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,NULL,'public','managed_form.submitted','managed_form_submission',?,?,?,?)",
    ).bind(
      uuid(),
      id,
      c.get('requestId'),
      JSON.stringify({ formId: form.id, opportunityId }),
      timestamp,
    ),
  ];
  const notificationJobId = uuid();
  if (form.notificationEnabled)
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO notification_jobs (id,job_type,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,'managed_form.submitted',?,'queued',0,?,?,?)",
      ).bind(
        notificationJobId,
        JSON.stringify({ submissionId: id }),
        timestamp,
        timestamp,
        timestamp,
      ),
    );
  await c.env.DB.batch(statements);
  if (form.notificationEnabled) {
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({
        jobId: notificationJobId,
        type: 'managed_form.submitted',
      });
    } catch {
      /* Durable row remains queued for scheduled recovery. */
    }
  }
  return c.json({ data: { accepted: true, reference: id } }, 202);
});
export default managed;
