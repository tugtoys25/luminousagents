import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { randomToken, sessionCookie, sha256Hex } from './password';
import { now, newId, BUYER_SESSION_SECONDS, emailSchema, err, throttled, clientIp, auditEvent } from './portal-shared';
import type { App } from './portal-shared';
import {
  findActiveBuyerByEmail,
  invalidateOpenEmailCodes,
  insertEmailCode,
  markEmailCodeUsed,
  findLatestEmailCode,
  closeOpenEmailCode,
  recordEmailCodeMiss,
  consumeEmailCode,
  createEmailCodeSession,
} from './portal-code-repo';

const portal = new Hono<App>();

/* ----------------------------------------------- buyer email-code sign-in */
const buyerCodeCookie = 'mayfair_buyer_session';
async function buyerCodeHash(email: string, code: string, secret: string): Promise<string> {
  return sha256Hex(`mayfair-buyer-code-v1:${secret}:${email.toLowerCase()}:${code}`);
}
async function sendBuyerCodeEmail(env: Env, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Your sign-in code · Casinos of Mayfair',
      html: `<p>Your Casinos of Mayfair sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.</p>`,
      text: `Your Casinos of Mayfair sign-in code is ${code}. It expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
}
portal.post('/api/buyer/auth/request-code', async (c) => {
  const input = z.object({ email: emailSchema }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter a valid email address.');
  const email = input.data.email.toLowerCase();
  if ((await throttled(c.env, `buyer-code-ip:${clientIp(c)}`, 10, 900)) || (await throttled(c.env, `buyer-code-email:${email}`, 5, 900)))
    return err(c, 429, 'RATE_LIMITED', 'Too many code requests. Please wait and try again.');
  const generic = { data: { accepted: true, message: 'If this is an active buyer account, a sign-in code has been sent.' } };
  if (!c.env.OTP_ENCRYPTION_KEY || c.env.OTP_ENCRYPTION_KEY.length < 32 || !c.env.RESEND_API_KEY || !c.env.EMAIL_FROM)
    return err(c, 503, 'EMAIL_CODE_UNAVAILABLE', 'Email-code sign-in is temporarily unavailable. Please use password sign-in or contact the team.');
  const user = await findActiveBuyerByEmail(c.env.DB, email);
  if (!user) return c.json(generic, 202);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  const timestamp = now();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const challengeId = newId();
  await invalidateOpenEmailCodes(c.env.DB, user.id, timestamp);
  await insertEmailCode(c.env.DB, {
    id: challengeId,
    userId: user.id,
    codeHash: await buyerCodeHash(user.email, code, c.env.OTP_ENCRYPTION_KEY),
    expiresAt: expires,
    timestamp,
  });
  try {
    await sendBuyerCodeEmail(c.env, user.email, code);
  } catch {
    await markEmailCodeUsed(c.env.DB, challengeId, now());
    return err(c, 503, 'EMAIL_DELIVERY_FAILED', 'We could not send a sign-in code. Please try again later or use password sign-in.');
  }
  await auditEvent(c.env, c, 'public', user.id, 'buyer.email_code_requested', challengeId);
  return c.json(generic, 202);
});
portal.post('/api/buyer/auth/verify-code', async (c) => {
  const input = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter your email and six-digit code.');
  const email = input.data.email.toLowerCase();
  if ((await throttled(c.env, `buyer-code-verify-ip:${clientIp(c)}`, 20, 900)) || (await throttled(c.env, `buyer-code-verify-email:${email}`, 10, 900)))
    return err(c, 429, 'RATE_LIMITED', 'Too many verification attempts. Please wait and try again.');
  if (!c.env.OTP_ENCRYPTION_KEY || c.env.OTP_ENCRYPTION_KEY.length < 32) return err(c, 503, 'EMAIL_CODE_UNAVAILABLE', 'Email-code sign-in is not configured.');
  const row = await findLatestEmailCode(c.env.DB, email);
  const timestamp = now();
  if (!row || row.status !== 'active' || row.expiresAt <= timestamp || row.attempts >= 5) return err(c, 401, 'INVALID_CODE', 'The code is invalid or expired. Request a new code and try again.');
  if (row.mustChange === 1) {
    await closeOpenEmailCode(c.env.DB, row.challengeId, timestamp);
    return err(c, 403, 'PASSWORD_CHANGE_REQUIRED', 'This account must complete its password change using password sign-in before email-code sign-in can be used.');
  }
  const candidate = await buyerCodeHash(row.email, input.data.code, c.env.OTP_ENCRYPTION_KEY);
  if (candidate !== row.codeHash) {
    await recordEmailCodeMiss(c.env.DB, row.challengeId, timestamp);
    return err(c, 401, 'INVALID_CODE', 'The code is invalid or expired. Request a new code and try again.');
  }
  const token = randomToken(32);
  const sessionId = newId();
  const expires = new Date(Date.now() + BUYER_SESSION_SECONDS * 1000).toISOString();
  if (!(await consumeEmailCode(c.env.DB, row.challengeId, timestamp))) return err(c, 401, 'INVALID_CODE', 'The code is invalid or expired. Request a new code and try again.');
  await createEmailCodeSession(c.env.DB, {
    userId: row.id,
    sessionId,
    tokenHash: await sha256Hex(token),
    timestamp,
    expiresAt: expires,
    auditId: newId(),
    requestId: c.get('requestId'),
  });
  c.header('Set-Cookie', sessionCookie(buyerCodeCookie, token, BUYER_SESSION_SECONDS));
  return c.json({ data: { id: row.id, email: row.email, displayName: row.displayName, expiresAt: expires, redirectTo: '/account' } });
});

export default portal;
