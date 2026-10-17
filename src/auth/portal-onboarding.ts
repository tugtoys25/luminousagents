import { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword, passwordPolicyError } from './password';
import { now, newId, PRIVACY_VERSION, emailSchema, err, throttled, clientIp, auditEvent } from './portal-shared';
import type { App } from './portal-shared';
import {
  countStaff,
} from './portal-repo';
import {
  findUnconfiguredStaffByEmail,
  provisionStaffPassword,
  insertFirstAdmin,
  staffUserExists,
  emailTaken,
  insertBuyerRegistration,
} from './portal-onboarding-repo';

const portal = new Hono<App>();

/* ------------------------------------------------ first administrator */

portal.post('/api/admin/bootstrap', async (c) => {
  const configured = c.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!configured || configured.length < 32)
    return err(c, 503, 'BOOTSTRAP_DISABLED', 'One-time administrator setup is not configured.');
  const input = z
    .object({
      displayName: z.string().trim().min(2).max(120),
      email: emailSchema,
      password: z.string().max(200),
      token: z.string().min(32).max(512),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return err(c, 422, 'VALIDATION_ERROR', 'Enter a valid name, email, password and setup token.');
  if (await throttled(c.env, `admin-bootstrap:${clientIp(c)}`, 5, 900))
    return err(c, 429, 'RATE_LIMITED', 'Setup attempts are temporarily limited.');
  const a = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.data.token)),
  );
  const b = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configured)),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  if (diff !== 0) return err(c, 403, 'INVALID_SETUP_TOKEN', 'Setup could not be authorised.');
  const email = input.data.email.toLowerCase();
  const policy = input.data.password ? passwordPolicyError(input.data.password, email) : null;
  if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
  const timestamp = now();
  const userId = newId();
  const hash = await hashPassword(input.data.password);
  // Credential migration: a staff account created before passwords existed (password_hash IS NULL) can be given
  // its first password here, using the same one-time token. Accounts that already have a password are never touched.
  const unconfigured = await findUnconfiguredStaffByEmail(c.env.DB, email);
  if (unconfigured) {
    const provisioned = await provisionStaffPassword(c.env.DB, {
      userId: unconfigured.id,
      passwordHash: hash,
      timestamp,
    });
    if (!provisioned)
      return err(
        c,
        409,
        'SETUP_CONFLICT',
        'Credentials could not be provisioned. Setup may already be complete.',
      );
    await auditEvent(
      c.env,
      c,
      'staff',
      unconfigured.id,
      'staff.credentials_bootstrapped',
      unconfigured.id,
    );
    return c.json(
      {
        data: {
          created: true,
          signInPath: '/admin/login',
          message: 'Password set. Sign in with your email and new password.',
        },
      },
      201,
    );
  }
  if ((await countStaff(c.env.DB)) > 0)
    return err(
      c,
      410,
      'SETUP_CLOSED',
      'Setup is closed for this email. If the account has no password yet, use that account email with the setup token.',
    );
  try {
    await insertFirstAdmin(c.env.DB, {
      userId,
      email,
      displayName: input.data.displayName,
      passwordHash: hash,
      timestamp,
      auditId: newId(),
      requestId: c.get('requestId'),
    });
  } catch {
    return err(
      c,
      409,
      'SETUP_CONFLICT',
      'Setup is already complete or the account could not be created.',
    );
  }
  const created = await staffUserExists(c.env.DB, userId);
  if (!created)
    return err(c, 410, 'SETUP_CLOSED', 'A staff account already exists; setup is closed.');
  return c.json(
    {
      data: {
        created: true,
        signInPath: '/admin/login',
        message:
          'Super administrator created. Setup is now closed — sign in with your email and password.',
      },
    },
    201,
  );
});

/* ----------------------------------------------------- buyer registration */

portal.post('/api/buyer/register', async (c) => {
  const input = z
    .object({
      displayName: z.string().trim().min(2).max(120),
      email: emailSchema,
      password: z.string().max(200).optional().default(''),
      companyName: z.string().trim().max(160).optional().default(''),
      roleTitle: z.string().trim().max(120).optional().default(''),
      investmentFocus: z
        .enum(['casino-hotel', 'casino', 'hotel', 'resort', 'other'])
        .default('casino-hotel'),
      consent: z.literal(true),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return err(c, 422, 'VALIDATION_ERROR', 'Check the registration details and try again.');
  const email = input.data.email.toLowerCase();
  const policy = input.data.password ? passwordPolicyError(input.data.password, email) : null;
  if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
  if (
    (await throttled(c.env, `buyer-register-email:${email}`, 5, 3600)) ||
    (await throttled(c.env, `buyer-register-ip:${clientIp(c)}`, 20, 3600))
  )
    return err(c, 429, 'RATE_LIMITED', 'Please wait before submitting another registration.');
  const accepted = {
    data: {
      accepted: true,
      message: 'Registration received. The team will review your details before enabling sign-in.',
    },
  };
  const existing = await emailTaken(c.env.DB, email);
  if (existing) return c.json(accepted, 202); // identical response avoids revealing registered emails
  const timestamp = now();
  const userId = newId();
  const jobId = newId();
  const hash = input.data.password ? await hashPassword(input.data.password) : null;
  try {
    await insertBuyerRegistration(c.env.DB, {
      userId,
      email,
      displayName: input.data.displayName,
      passwordHash: hash,
      companyName: input.data.companyName,
      roleTitle: input.data.roleTitle,
      experienceNotes: `Investment focus: ${input.data.investmentFocus}`,
      privacyVersion: PRIVACY_VERSION,
      timestamp,
      auditId: newId(),
      requestId: c.get('requestId'),
      auditDetailsJson: JSON.stringify({
        investmentFocus: input.data.investmentFocus,
        consentVersion: PRIVACY_VERSION,
      }),
      jobId,
      jobPayloadJson: JSON.stringify({ userId }),
    });
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({ jobId, type: 'buyer.registration_review' });
    } catch {
      /* durable job remains queued for scheduled recovery */
    }
  } catch {
    /* concurrent duplicate: stay silent */
  }
  return c.json(accepted, 202);
});

export default portal;
