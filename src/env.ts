import { z } from 'zod';

export const AppEnvironmentSchema = z.enum(['dev', 'staging', 'production']);
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export interface Env {
  APP_ENV: AppEnvironment;
  IP_HASH_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Temporary rollout switch. Leave unset (enforce). `log-only` logs and allows failed checks. */
  TURNSTILE_ENFORCEMENT?: string;
  OTP_ENCRYPTION_KEY?: string;
  /** Optional dedicated 32-byte base64 key for MFA secrets; falls back to OTP_ENCRYPTION_KEY. */
  MFA_ENCRYPTION_KEY?: string;
  /** Comma list of roles that must use MFA. Unset = super_admin,admin. Empty string = none. */
  STAFF_MFA_REQUIRED_ROLES?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  RESEND_API_KEY?: string;
  MALWARE_SCANNER_API_URL?: string;
  MALWARE_SCANNER_API_TOKEN?: string;
  MALWARE_SCANNER_SIGNING_SECRET?: string;
  MALWARE_SCANNER_PROVIDER?: string;
  EMAIL_FROM?: string;
  /** Seller workflow: verified sender for seller-facing mail; falls back to EMAIL_FROM when unset. */
  SELLER_EMAIL_FROM?: string;
  SELLER_REPLY_TO?: string;
  /** Comma list of internal recipients for new seller enquiry alerts. Required: alerts fail visibly (retry, then dead) when unset. */
  SELLER_ALERT_RECIPIENTS?: string;
  SELLER_ALERT_INCLUDE_PHONE?: string;
  SELLER_ALERT_INCLUDE_PRICE?: string;
  /** Public company website shown in seller emails. Falls back to PUBLIC_BASE_URL. */
  SELLER_COMPANY_WEBSITE?: string;
  /** 'true' only after legal review of marketing consent; otherwise the checkbox is not offered and consent is never recorded. */
  SELLER_MARKETING_CONSENT_ENABLED?: string;
  /** 'false' disables follow-up reminders. */
  /** 'false' disables separation of duties (verifier/approver must differ from the preparer). Default: enforced. */
  SELLER_SEPARATION_OF_DUTIES?: string;
  SELLER_REMINDERS_ENABLED?: string;
  SELLER_REMINDER_INTERVAL_HOURS?: string;
  /** Hours overdue before a one-off escalation email; unset or 0 disables escalation. Needs SELLER_ESCALATION_RECIPIENTS. */
  SELLER_ESCALATION_AFTER_HOURS?: string;
  SELLER_ESCALATION_RECIPIENTS?: string;
  OPS_EMAIL?: string;
  PUBLIC_BASE_URL?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_CACHE_PURGE_TOKEN?: string;
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
  DB: D1Database;
  PRIVATE_FILES: R2Bucket;
  CACHE: KVNamespace;
  NOTIFICATIONS_QUEUE: Queue;
  ASSETS: Fetcher;
}

/** Validate non-secret deployment configuration at a boundary, not on every request. */
export function parseAppEnvironment(value: unknown): AppEnvironment {
  return AppEnvironmentSchema.parse(value);
}
