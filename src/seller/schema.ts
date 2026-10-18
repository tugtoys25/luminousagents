import { z } from 'zod';
import { COUNTRY_CODES } from './countries';

export const MAX_BODY_BYTES = 32 * 1024;

export const PRIVACY_ACK_VERSION = 'seller-form-privacy-ack-v1';
export const ACCURACY_DECLARATION_VERSION = 'seller-form-accuracy-v1';
export const MARKETING_CONSENT_VERSION = 'seller-form-marketing-v1';

export const PRIVACY_ACK_TEXT =
  'I acknowledge that I have read the Privacy Notice and understand that Casinos of Mayfair will process the personal information I provide to review and respond to my enquiry.';
export const ACCURACY_DECLARATION_TEXT =
  'I confirm that the information I have provided is accurate to the best of my knowledge and that I am entitled to submit this enquiry. I understand that submitting this form does not establish that I have authority to sell the asset or authorise Casinos of Mayfair to market it.';
export const MARKETING_CONSENT_TEXT =
  "I would like to receive occasional updates about Casinos of Mayfair's services and relevant investment opportunities. I understand that I can withdraw this consent at any time.";

export const CONTACT_ROLES = ['OWNER', 'DIRECTOR_EXECUTIVE', 'AUTHORISED_REPRESENTATIVE', 'BROKER_INTERMEDIARY', 'PROFESSIONAL_ADVISER', 'OTHER'] as const;
export const CONTACT_METHODS = ['EMAIL', 'TELEPHONE', 'EITHER'] as const;
export const ASSET_TYPES = ['CASINO', 'CASINO_HOTEL', 'HOTEL_RESORT_WITH_CASINO', 'OPERATING_COMPANY', 'RELATED_PROPERTY_HOSPITALITY_ASSET', 'OTHER_RELATED_INVESTMENT'] as const;
export const OPERATING_STATUSES = ['OPERATING', 'TEMPORARILY_CLOSED', 'UNDER_DEVELOPMENT', 'NOT_YET_OPERATING', 'DISCUSS_PRIVATELY'] as const;
export const AUTHORITY_DECLARATIONS = ['YES', 'NO', 'UNSURE'] as const;
export const SALE_REASONS = ['STRATEGIC_DECISION', 'OWNERSHIP_CHANGE_SUCCESSION', 'PORTFOLIO_RESTRUCTURING', 'INVESTMENT_REALISATION', 'OTHER', 'DISCUSS_PRIVATELY'] as const;
export const SALE_TIMINGS = ['ASAP', 'WITHIN_3_MONTHS', 'WITHIN_6_MONTHS', 'WITHIN_12_MONTHS', 'OVER_12_MONTHS', 'EXPLORING'] as const;
export const CURRENCIES = ['GBP', 'EUR', 'USD', 'CHF', 'AED', 'OTHER'] as const;
export const CONFIDENTIALITY_PREFERENCES = ['CONTACT_BEFORE_PUBLIC_IDENTIFICATION', 'DISCUSS_PUBLIC_LISTING_AFTER_REVIEW', 'DISCUSS_WITH_BROKER'] as const;

// Single-line fields: any control character (incl. CR/LF, which enables header injection) is rejected.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Multi-line fields: newline and tab allowed, other control characters rejected.
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

const line = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((v) => !CONTROL.test(v), 'Contains unsupported characters');
const optionalLine = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), line(1, max).optional());
const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((v) => !CONTROL_EXCEPT_NEWLINE.test(v), 'Contains unsupported characters');
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), text(1, max).optional());
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(values).optional());
const country = z.string().trim().toUpperCase().refine((v) => COUNTRY_CODES.has(v), 'Select a country');
/** Checkbox/boolean tolerant of JSON true and form values; anything else is false. */
const checked = z.preprocess((v) => v === true || v === 'true' || v === 'on' || v === '1', z.boolean());

export const sellerEnquirySchema = z
  .object({
    contact_name: line(2, 120),
    contact_role: z.enum(CONTACT_ROLES),
    contact_role_other: optionalLine(120),
    email: z.string().trim().max(254).email().refine((v) => !CONTROL.test(v), 'Invalid email'),
    telephone: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      line(1, 40)
        .refine((v) => /^[0-9+()\-.\s/xX#]+$/.test(v), 'Enter a valid telephone number')
        .refine((v) => (v.match(/[0-9]/g) ?? []).length >= 5, 'Enter a valid telephone number')
        .optional(),
    ),
    organisation: optionalLine(160),
    preferred_contact_method: z.enum(CONTACT_METHODS),
    contact_country: country,
    asset_type: z.enum(ASSET_TYPES),
    asset_type_other: optionalLine(120),
    asset_country: country,
    asset_name: optionalLine(160),
    asset_name_confidential: z.enum(['YES', 'NO']),
    asset_description: text(30, 2000),
    operating_status: z.enum(OPERATING_STATUSES),
    authority_declaration: z.enum(AUTHORITY_DECLARATIONS),
    sale_reason: optionalEnum(SALE_REASONS),
    sale_timing: z.enum(SALE_TIMINGS),
    asking_price_text: optionalLine(100),
    currency: optionalEnum(CURRENCIES),
    currency_other: optionalLine(20),
    additional_information: optionalText(2000),
    confidentiality_preference: z.enum(CONFIDENTIALITY_PREFERENCES),
    privacy_acknowledged: checked,
    accuracy_declared: checked,
    marketing_consent: checked.optional().default(false),
    // Browser-generated per-page-load key used only for duplicate-submission protection.
    idempotency_key: z.string().trim().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Invalid submission key'),
  })
  .superRefine((d, ctx) => {
    const need = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (d.contact_role === 'OTHER' && (!d.contact_role_other || d.contact_role_other.length < 3))
      need('contact_role_other', 'Describe your role (at least 3 characters)');
    if (d.asset_type === 'OTHER_RELATED_INVESTMENT' && (!d.asset_type_other || d.asset_type_other.length < 3))
      need('asset_type_other', 'Describe the asset type (at least 3 characters)');
    if (d.asking_price_text && !d.currency) need('currency', 'Select a currency');
    if (d.asking_price_text && d.currency === 'OTHER' && !d.currency_other) need('currency_other', 'Enter the currency');
    if (!d.privacy_acknowledged) need('privacy_acknowledged', 'You must acknowledge the Privacy Notice');
    if (!d.accuracy_declared) need('accuracy_declared', 'You must confirm the declaration');
  });

export type SellerEnquiryInput = z.infer<typeof sellerEnquirySchema>;

/** Values that are only meaningful in combination are dropped when the controlling field says they are not applicable. */
export function normaliseSellerEnquiry(d: SellerEnquiryInput, marketingEnabled: boolean) {
  const hasPrice = Boolean(d.asking_price_text);
  return {
    ...d,
    email: d.email.toLowerCase(),
    contact_role_other: d.contact_role === 'OTHER' ? (d.contact_role_other ?? null) : null,
    asset_type_other: d.asset_type === 'OTHER_RELATED_INVESTMENT' ? (d.asset_type_other ?? null) : null,
    asking_price_text: hasPrice ? d.asking_price_text! : null,
    currency: hasPrice ? (d.currency ?? null) : null,
    currency_other: hasPrice && d.currency === 'OTHER' ? (d.currency_other ?? null) : null,
    marketing_consent: marketingEnabled && d.marketing_consent,
  };
}
export type NormalisedSellerEnquiry = ReturnType<typeof normaliseSellerEnquiry>;

/** Field-level errors safe to return to the browser (messages are ours, never echoing input). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
