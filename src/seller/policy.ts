/**
 * Seller policy: values that used to be environment-only and can now be edited in the dashboard.
 * Precedence for each setting: a valid database value, else the environment variable, else the safe default.
 * An invalid stored value is ignored (never trusted), so a bad edit cannot disable a safeguard by accident.
 */
import type { Env } from '../env';

export interface SellerPolicy {
  remindersEnabled: boolean;
  reminderIntervalHours: number;
  escalationAfterHours: number;
  escalationRecipients: string[];
  alertRecipients: string[];
  alertIncludePhone: boolean;
  alertIncludePrice: boolean;
  separationOfDuties: boolean;
  materialInterestDualApproval: boolean;
  retentionReviewDays: number | null;
  marketingConsentEnabled: boolean;
}

export type SettingKind = 'boolean' | 'integer' | 'optionalInteger' | 'emails';
export interface SettingDef {
  key: string;
  field: keyof SellerPolicy;
  label: string;
  description: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  /** Sensitive settings weaken a safeguard or affect legal posture: super admin only, recent MFA, reason recorded. */
  sensitive: boolean;
  envVar: string;
}

export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'reminders_enabled', field: 'remindersEnabled', label: 'Follow-up reminders', description: 'Send internal reminders for overdue follow-up tasks.', kind: 'boolean', sensitive: false, envVar: 'SELLER_REMINDERS_ENABLED' },
  { key: 'reminder_interval_hours', field: 'reminderIntervalHours', label: 'Reminder interval (hours)', description: 'Minimum time between reminders for the same task. Not a commitment to sellers.', kind: 'integer', min: 1, max: 168, sensitive: false, envVar: 'SELLER_REMINDER_INTERVAL_HOURS' },
  { key: 'escalation_after_hours', field: 'escalationAfterHours', label: 'Escalate after (hours overdue)', description: '0 disables escalation. Needs escalation recipients.', kind: 'integer', min: 0, max: 720, sensitive: false, envVar: 'SELLER_ESCALATION_AFTER_HOURS' },
  { key: 'escalation_recipients', field: 'escalationRecipients', label: 'Escalation recipients', description: 'Internal addresses told when a follow-up is escalated (up to 10).', kind: 'emails', max: 10, sensitive: false, envVar: 'SELLER_ESCALATION_RECIPIENTS' },
  { key: 'alert_recipients', field: 'alertRecipients', label: 'New-enquiry alert recipients', description: 'Internal addresses that receive new seller enquiry alerts (up to 10). If empty, alerts fail visibly.', kind: 'emails', max: 10, sensitive: false, envVar: 'SELLER_ALERT_RECIPIENTS' },
  { key: 'alert_include_phone', field: 'alertIncludePhone', label: 'Include telephone in alerts', description: 'Adds the seller telephone number to the internal alert email.', kind: 'boolean', sensitive: false, envVar: 'SELLER_ALERT_INCLUDE_PHONE' },
  { key: 'alert_include_price', field: 'alertIncludePrice', label: 'Include asking price in alerts', description: 'Adds the stated asking price to the internal alert email.', kind: 'boolean', sensitive: false, envVar: 'SELLER_ALERT_INCLUDE_PRICE' },
  { key: 'separation_of_duties', field: 'separationOfDuties', label: 'Separation of duties', description: 'The person who records an authority claim or prepares a publication review cannot verify or approve it. Turning this off weakens a control.', kind: 'boolean', sensitive: true, envVar: 'SELLER_SEPARATION_OF_DUTIES' },
  { key: 'material_interest_dual_approval', field: 'materialInterestDualApproval', label: 'Dual approval of material-interest notices', description: 'A second person must approve a notice and the interest review.', kind: 'boolean', sensitive: true, envVar: 'SELLER_MATERIAL_INTEREST_DUAL_APPROVAL' },
  { key: 'retention_review_days', field: 'retentionReviewDays', label: 'Retention review period (days)', description: 'Days after closure before an unlinked enquiry is listed for retention review. Leave unset until the business has approved a period.', kind: 'optionalInteger', min: 1, max: 36500, sensitive: true, envVar: 'SELLER_RETENTION_REVIEW_DAYS' },
  { key: 'marketing_consent_enabled', field: 'marketingConsentEnabled', label: 'Offer optional marketing consent on the public form', description: 'Show the marketing checkbox on /sell-a-casino. Only after legal review of the legal basis and process.', kind: 'boolean', sensitive: true, envVar: 'SELLER_MARKETING_CONSENT_ENABLED' },
];
export const settingDef = (key: string): SettingDef | undefined => SETTING_DEFS.find((d) => d.key === key);

const isEmail = (v: string): boolean => v.length <= 254 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v);
export const parseEmails = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((v) => v.trim()).filter(isEmail).slice(0, 10);
const intIn = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

/** The environment-and-defaults view. Pure; this is what the code used before settings became editable. */
export function policyFromEnv(env: Pick<Env, never> & Partial<Record<string, string | undefined>>): SellerPolicy {
  const days = Number.parseInt(env['SELLER_RETENTION_REVIEW_DAYS'] ?? '', 10);
  return {
    remindersEnabled: env['SELLER_REMINDERS_ENABLED'] !== 'false',
    reminderIntervalHours: intIn(env['SELLER_REMINDER_INTERVAL_HOURS'], 24, 1, 168),
    escalationAfterHours: intIn(env['SELLER_ESCALATION_AFTER_HOURS'], 0, 1, 720),
    escalationRecipients: parseEmails(env['SELLER_ESCALATION_RECIPIENTS']),
    alertRecipients: parseEmails(env['SELLER_ALERT_RECIPIENTS']),
    alertIncludePhone: env['SELLER_ALERT_INCLUDE_PHONE'] === 'true',
    alertIncludePrice: env['SELLER_ALERT_INCLUDE_PRICE'] === 'true',
    separationOfDuties: env['SELLER_SEPARATION_OF_DUTIES'] !== 'false',
    materialInterestDualApproval: env['SELLER_MATERIAL_INTEREST_DUAL_APPROVAL'] === 'true',
    retentionReviewDays: Number.isFinite(days) && days >= 1 ? Math.min(days, 36500) : null,
    marketingConsentEnabled: env['SELLER_MARKETING_CONSENT_ENABLED'] === 'true',
  };
}

export type ValidatedValue = { ok: true; value: boolean | number | string[] | null } | { ok: false; message: string };
/** Strict validation for a value coming from the editor (or from storage). */
export function validateSettingValue(def: SettingDef, value: unknown): ValidatedValue {
  switch (def.kind) {
    case 'boolean': return typeof value === 'boolean' ? { ok: true, value } : { ok: false, message: 'Must be true or false.' };
    case 'integer':
    case 'optionalInteger': {
      if (value === null && def.kind === 'optionalInteger') return { ok: true, value: null };
      if (typeof value !== 'number' || !Number.isInteger(value) || value < (def.min ?? 0) || value > (def.max ?? 1_000_000)) return { ok: false, message: `Must be a whole number from ${def.min ?? 0} to ${def.max ?? 1_000_000}.` };
      return { ok: true, value };
    }
    case 'emails': {
      if (!Array.isArray(value) || value.length > (def.max ?? 10)) return { ok: false, message: `Provide up to ${def.max ?? 10} email addresses.` };
      const list = value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''));
      if (!list.every(isEmail)) return { ok: false, message: 'Every entry must be a valid email address.' };
      return { ok: true, value: [...new Set(list)] };
    }
  }
}

export interface StoredSetting { key: string; value: string; version: number; updatedAt: string }
export type Source = 'database' | 'environment' | 'default';

/** Applies stored overrides on top of the environment view. Unknown keys and invalid values are ignored. */
export function applyOverrides(base: SellerPolicy, stored: readonly StoredSetting[], env: Partial<Record<string, string | undefined>> = {}): { policy: SellerPolicy; sources: Record<string, Source> } {
  const policy: SellerPolicy = { ...base };
  const sources: Record<string, Source> = {};
  for (const def of SETTING_DEFS) sources[def.key] = (env[def.envVar] ?? '') !== '' ? 'environment' : 'default';
  for (const row of stored) {
    const def = settingDef(row.key);
    if (!def) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value); } catch { continue; }
    const result = validateSettingValue(def, parsed);
    if (!result.ok) continue;
    (policy as unknown as Record<string, unknown>)[def.field] = result.value;
    sources[def.key] = 'database';
  }
  return { policy, sources };
}
