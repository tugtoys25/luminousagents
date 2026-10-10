import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';

const portal = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function page(title: string, heading: string, intro: string, form: string, links: string, storyTitle = 'A considered approach to <em>exceptional assets.</em>') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)} · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/portal.css"></head><body><main class="shell"><aside class="story"><div><div class="brand"><span class="mark">M</span><span>CASINOS OF MAYFAIR<br><small class="brand-subtitle">INTERNATIONAL BROKERAGE</small></span></div><h1>${storyTitle}</h1><p>Private access for qualified buyers and a carefully controlled workspace for the team behind each opportunity.</p></div><div class="story-foot">CONFIDENTIAL BY DESIGN · ACCESS IS ROLE-BASED</div></aside><section class="panel"><span class="eyebrow">${escape(title.toUpperCase())}</span><h2>${escape(heading)}</h2><p class="muted">${escape(intro)}</p>${form}<div class="links">${links}</div><p class="fine">Never share passwords or confidential deal materials by email. All opportunities remain subject to verification and appropriate due diligence.</p></section></main></body></html>`;
}

portal.get('/admin/login', async (c) => {
  const staffCount = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE user_type = 'staff'").first<{total:number}>();
  const setupLink = (staffCount?.total ?? 0) === 0 && Boolean(c.env.ADMIN_BOOTSTRAP_TOKEN && c.env.ADMIN_BOOTSTRAP_TOKEN.length >= 32) ? '<a href="/admin/setup">First administrator setup</a>' : '';
  return c.html(page('Staff sign in', 'Welcome back.', 'Staff access is managed through your organisation’s Cloudflare Access sign-in policy.', `<div class="pill">Staff-only workspace</div><a class="btn" href="/dashboard">Continue to secure workspace <span aria-hidden="true">→</span></a><p class="fine">If you are not authorised, contact your platform administrator. The workspace will reject identities that are not provisioned as active staff.</p>`, `<a href="/">Public website</a>${setupLink}`, 'Good decisions start with <em>trusted access.</em>'));
});

portal.get('/admin/setup', async (c) => {
  const staffCount = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE user_type = 'staff'").first<{total:number}>();
  if ((staffCount?.total ?? 0) > 0) return c.html(page('Setup closed', 'Administrator setup is closed.', 'The one-time first-administrator registration has already been completed. Use the staff sign-in flow.', `<a class="btn" href="/admin/login">Go to staff sign in</a>`, `<a href="/">Public website</a>`), 410);
  if (!c.env.ADMIN_BOOTSTRAP_TOKEN || c.env.ADMIN_BOOTSTRAP_TOKEN.length < 32) return c.html(page('Setup unavailable', 'Initial setup is not enabled.', 'The deployer must configure a strong one-time bootstrap secret before the first administrator form can be used.', `<a class="btn" href="/admin/login">Go to staff sign in</a>`, `<a href="/">Public website</a>`), 503);
  return c.html(page('First administrator setup', 'Create the first administrator.', 'This one-time form only works while no staff account exists and only with the server-side bootstrap secret configured by the deployer.', `<form id="bootstrap-form"><div class="field"><label for="name">Full name</label><input id="name" name="displayName" autocomplete="name" minlength="2" maxlength="120" required></div><div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required></div><div class="field"><label for="token">One-time setup token</label><input id="token" name="token" type="password" autocomplete="off" minlength="32" required></div><button type="submit">Register first administrator</button><p id="notice" class="notice" role="status"></p></form><script src="/static/js/portal-bootstrap.js" defer></script>`, `<a href="/admin/login">Staff sign in</a><a href="/">Public website</a>`, 'Set the foundation for <em>trusted stewardship.</em>'));
});

portal.post('/api/admin/bootstrap', async (c) => {
  const configured = c.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!configured || configured.length < 32) return c.json({ error: { code: 'BOOTSTRAP_DISABLED', message: 'One-time administrator setup is not configured.' } }, 503);
  const input = z.object({ displayName: z.string().trim().min(2).max(120), email: z.string().trim().email().max(254), token: z.string().min(32).max(512) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid name, email and setup token.' } }, 422);
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const ipKey = [...new Uint8Array(ipDigest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const throttleKey = `admin-bootstrap:${ipKey}`;
  const attempts = Number.parseInt((await c.env.CACHE.get(throttleKey)) ?? '0', 10) || 0;
  if (attempts >= 5) return c.json({ error: { code: 'RATE_LIMITED', message: 'Setup attempts are temporarily limited.' } }, 429);
  const suppliedHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.data.token));
  const expectedHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configured));
  const a = new Uint8Array(suppliedHash); const b = new Uint8Array(expectedHash); let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  if (diff !== 0) { await c.env.CACHE.put(throttleKey, String(attempts + 1), { expirationTtl: 900 }); return c.json({ error: { code: 'INVALID_SETUP_TOKEN', message: 'Setup could not be authorised.' } }, 403); }
  await c.env.CACHE.delete(throttleKey);
  const email = input.data.email.toLowerCase(); const timestamp = now(); const userId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id,email,display_name,user_type,role,status,created_at,updated_at) SELECT ?, ?, ?, 'staff', 'super_admin', 'active', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_type = 'staff')").bind(userId, email, input.data.displayName, timestamp, timestamp),
      c.env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) SELECT ?, ?, 'staff', 'staff.first_admin_bootstrapped', 'user', ?, ?, '{}', ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND user_type = 'staff')").bind(newId(), userId, userId, c.get('requestId'), timestamp, userId),
    ]);
  } catch { return c.json({ error: { code: 'SETUP_CONFLICT', message: 'Setup is already complete or the account could not be created.' } }, 409); }
  const created = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND user_type = 'staff'").bind(userId).first();
  if (!created) return c.json({ error: { code: 'SETUP_CLOSED', message: 'A staff account already exists; setup is closed.' } }, 410);
  return c.json({ data: { created: true, signInPath: '/admin/login', message: 'Administrator created. Staff authentication still requires Cloudflare Access.' } }, 201);
});

portal.get('/register', (c) => c.html(page('Buyer registration', 'Your next opportunity starts here.', 'Create a buyer profile. New accounts require team approval before sign-in and confidential access are enabled.', `<form id="buyer-register"><div class="field"><label for="name">Full name</label><input id="name" name="displayName" autocomplete="name" minlength="2" maxlength="120" required></div><div class="field"><label for="email">Business email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required></div><div class="field"><label for="company">Company</label><input id="company" name="companyName" autocomplete="organization" maxlength="160"></div><div class="field"><label for="role">Role / title</label><input id="role" name="roleTitle" maxlength="120"></div><div class="field"><label for="interest">Investment focus</label><select name="investmentFocus"><option value="casino-hotel">Casino & hotel</option><option value="casino">Casino</option><option value="hotel">Hotel / hospitality</option><option value="resort">Resort / destination</option><option value="other">Other</option></select></div><div class="field"><label class="consent-row"><input class="consent-checkbox" type="checkbox" name="consent" required> I have read the <a href="/legal/privacy">privacy notice</a> and agree that the team may use these details to review my registration.</label></div><button type="submit">Submit registration</button><p id="notice" class="notice" role="status"></p></form><script src="/static/js/portal-register.js" defer></script>`, `<a href="/account">Buyer sign in</a><a href="/">Public website</a>`, 'Access to the right information, <em>at the right time.</em>')));

portal.post('/api/buyer/register', async (c) => {
  const input = z.object({ displayName: z.string().trim().min(2).max(120), email: z.string().trim().email().max(254), companyName: z.string().trim().max(160).optional().default(''), roleTitle: z.string().trim().max(120).optional().default(''), investmentFocus: z.enum(['casino-hotel','casino','hotel','resort','other']).default('casino-hotel'), consent: z.literal(true) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Check the registration details and try again.' } }, 422);
  const email = input.data.email.toLowerCase();
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const emailHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  const ipHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const toHex = (value: ArrayBuffer) => [...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const emailKey = `buyer-register-email:${toHex(emailHash)}`;
  const ipKey = `buyer-register-ip:${toHex(ipHash)}`;
  const emailAttempts = Number.parseInt((await c.env.CACHE.get(emailKey)) ?? '0', 10) || 0;
  const ipAttempts = Number.parseInt((await c.env.CACHE.get(ipKey)) ?? '0', 10) || 0;
  if (emailAttempts >= 5 || ipAttempts >= 20) return c.json({ error: { code: 'RATE_LIMITED', message: 'Please wait before submitting another registration.' } }, 429);
  await Promise.all([
    c.env.CACHE.put(emailKey, String(emailAttempts + 1), { expirationTtl: 3600 }),
    c.env.CACHE.put(ipKey, String(ipAttempts + 1), { expirationTtl: 3600 }),
  ]);
  const timestamp = now(); const userId = newId();
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  if (existing) return c.json({ data: { accepted: true, message: 'If the details are eligible, the team will review the registration and contact you.' } }, 202);
  const jobId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id,email,display_name,user_type,role,status,created_at,updated_at) VALUES (?, ?, ?, 'buyer', 'buyer', 'invited', ?, ?)").bind(userId, email, input.data.displayName, timestamp, timestamp),
      c.env.DB.prepare("INSERT INTO buyer_profiles (user_id,company_name,role_title,experience_notes,updated_at,privacy_consent_at,privacy_notice_version) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(userId, input.data.companyName, input.data.roleTitle, `Investment focus: ${input.data.investmentFocus}`, timestamp, timestamp, '2026-10-10-v1'),
      c.env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?, NULL, 'public', 'buyer.registration_submitted', 'user', ?, ?, ?, ?)").bind(newId(), userId, c.get('requestId'), JSON.stringify({ investmentFocus: input.data.investmentFocus, consentVersion: '2026-10-10-v1' }), timestamp),
      c.env.DB.prepare("INSERT INTO notification_jobs (id,job_type,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,'buyer.registration_review',?,'queued',0,?,?,?)").bind(jobId, JSON.stringify({ userId }), timestamp, timestamp, timestamp),
    ]);
    try { await c.env.NOTIFICATIONS_QUEUE.send({ jobId, type: 'buyer.registration_review' }); } catch { /* durable job remains queued for scheduled recovery */ }
  } catch {
    // Avoid exposing whether an email is already present during concurrent submissions.
  }
  return c.json({ data: { accepted: true, message: 'Registration received. The team will review your details before enabling sign-in.' } }, 202);
});

export default portal;
