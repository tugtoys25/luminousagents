import { z } from 'zod';

export const AppEnvironmentSchema = z.enum(['dev', 'staging', 'production']);
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export interface Env {
  APP_ENV: AppEnvironment;
  IP_HASH_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  OTP_ENCRYPTION_KEY?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  RESEND_API_KEY?: string;
  MALWARE_SCANNER_API_URL?: string;
  MALWARE_SCANNER_API_TOKEN?: string;
  MALWARE_SCANNER_SIGNING_SECRET?: string;
  MALWARE_SCANNER_PROVIDER?: string;
  EMAIL_FROM?: string;
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
