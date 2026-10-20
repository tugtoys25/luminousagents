/** All SQL for public seller enquiries. Routes call these; they never touch D1 directly. */
import type { NormalisedSellerEnquiry } from './schema';
import { ACCURACY_DECLARATION_VERSION, MARKETING_CONSENT_VERSION, PRIVACY_ACK_VERSION } from './schema';

export const JOB_ACK = 'seller.enquiry_ack';
export const JOB_INTERNAL_ALERT = 'seller.enquiry_internal_alert';
export const JOB_FOLLOWUP_DUE = 'seller.followup_due';
export const JOB_ASSIGNMENT = 'seller.enquiry_assigned';

export interface SellerEnquiryInsert {
  id: string;
  reference: string;
  data: NormalisedSellerEnquiry;
  idempotencyHash: string;
  sourceIpHash: string | null;
  requestId: string;
  auditId: string;
  ackJobId: string;
  alertJobId: string;
  timestamp: string;
}

export async function findByIdempotencyHash(db: D1Database, hash: string): Promise<{ reference: string } | null> {
  return db.prepare('SELECT reference FROM seller_enquiries WHERE idempotency_hash = ? LIMIT 1').bind(hash).first<{ reference: string }>();
}

const JOB_SQL =
  "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at, dedupe_key) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)";

/**
 * Enquiry, audit row and both notification jobs commit atomically in one batch. The enquiry is persisted
 * before any email work is attempted; the job rows are the durable outbox. Job payloads carry only the id.
 * Throws on a UNIQUE violation (reference collision or duplicate idempotency key); the caller decides which.
 */
export async function insertSellerEnquiry(db: D1Database, e: SellerEnquiryInsert): Promise<void> {
  const d = e.data;
  const t = e.timestamp;
  const marketing = d.marketing_consent ? 1 : 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO seller_enquiries (id, reference, contact_name, contact_role, contact_role_other, email, telephone, organisation,
          preferred_contact_method, contact_country, asset_type, asset_type_other, asset_country, asset_name, asset_name_confidential,
          asset_description, operating_status, authority_declaration, sale_reason, sale_timing, asking_price_text, currency, currency_other,
          additional_information, confidentiality_preference, privacy_notice_version, privacy_acknowledged_at, accuracy_declaration_version,
          accuracy_declared_at, marketing_consent, marketing_consent_text_version, marketing_consent_at, status, idempotency_hash,
          source_ip_hash, original_submission_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NEW',?,?,?,?,?)`,
      )
      .bind(
        e.id, e.reference, d.contact_name, d.contact_role, d.contact_role_other, d.email, d.telephone ?? null, d.organisation ?? null,
        d.preferred_contact_method, d.contact_country, d.asset_type, d.asset_type_other, d.asset_country, d.asset_name ?? null,
        d.asset_name_confidential === 'YES' ? 1 : 0, d.asset_description, d.operating_status, d.authority_declaration,
        d.sale_reason ?? null, d.sale_timing, d.asking_price_text, d.currency, d.currency_other, d.additional_information ?? null,
        d.confidentiality_preference, PRIVACY_ACK_VERSION, t, ACCURACY_DECLARATION_VERSION, t, marketing,
        marketing ? MARKETING_CONSENT_VERSION : null, marketing ? t : null, e.idempotencyHash, e.sourceIpHash,
        JSON.stringify(originalSubmission(d)), t, t,
      ),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, NULL, 'public', 'seller_enquiry.created', 'seller_enquiry', ?, ?, ?, ?)",
      )
      .bind(e.auditId, e.id, e.requestId, JSON.stringify({ reference: e.reference, status: 'NEW', marketingConsent: Boolean(marketing) }), t),
    db.prepare(JOB_SQL).bind(e.ackJobId, JOB_ACK, JSON.stringify({ enquiryId: e.id }), t, t, t, `seller_enquiry_ack:${e.id}`),
    db.prepare(JOB_SQL).bind(e.alertJobId, JOB_INTERNAL_ALERT, JSON.stringify({ enquiryId: e.id }), t, t, t, `seller_enquiry_internal_alert:${e.id}`),
  ]);
}

/** The submission as validated, without the idempotency key or acknowledgement booleans. */
function originalSubmission(d: NormalisedSellerEnquiry): Record<string, unknown> {
  const { idempotency_key: _key, privacy_acknowledged: _p, accuracy_declared: _a, ...rest } = d;
  void _key; void _p; void _a;
  return rest;
}

export interface SellerEnquiryForEmail {
  id: string;
  reference: string;
  contactName: string;
  contactRole: string;
  email: string;
  telephone: string | null;
  organisation: string | null;
  preferredContactMethod: string;
  contactCountry: string;
  assetType: string;
  assetCountry: string;
  assetName: string | null;
  assetNameConfidential: number;
  operatingStatus: string;
  saleTiming: string;
  askingPriceText: string | null;
  currency: string | null;
  confidentialityPreference: string;
  authorityDeclaration: string;
  status: string;
  createdAt: string;
  marketingConsent: number;
}

export function findSellerEnquiryForEmail(db: D1Database, id: string): Promise<SellerEnquiryForEmail | null> {
  return db
    .prepare(
      `SELECT id, reference, contact_name AS contactName, contact_role AS contactRole, email, telephone, organisation,
        preferred_contact_method AS preferredContactMethod, contact_country AS contactCountry, asset_type AS assetType,
        asset_country AS assetCountry, asset_name AS assetName, asset_name_confidential AS assetNameConfidential,
        operating_status AS operatingStatus, sale_timing AS saleTiming, asking_price_text AS askingPriceText, currency,
        confidentiality_preference AS confidentialityPreference, authority_declaration AS authorityDeclaration, status,
        created_at AS createdAt, marketing_consent AS marketingConsent
       FROM seller_enquiries WHERE id = ? AND anonymised_at IS NULL`,
    )
    .bind(id)
    .first<SellerEnquiryForEmail>();
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
