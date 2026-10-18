-- Seller enquiries (public /sell-a-casino). Separate from the general contact-form `enquiries` table
-- because the lifecycle, declarations and consent records differ. Forward-only; no existing data is touched.
CREATE TABLE IF NOT EXISTS seller_enquiries (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  contact_name TEXT NOT NULL,
  contact_role TEXT NOT NULL CHECK (contact_role IN ('OWNER','DIRECTOR_EXECUTIVE','AUTHORISED_REPRESENTATIVE','BROKER_INTERMEDIARY','PROFESSIONAL_ADVISER','OTHER')),
  contact_role_other TEXT,
  email TEXT NOT NULL,
  telephone TEXT,
  organisation TEXT,
  preferred_contact_method TEXT NOT NULL CHECK (preferred_contact_method IN ('EMAIL','TELEPHONE','EITHER')),
  contact_country TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('CASINO','CASINO_HOTEL','HOTEL_RESORT_WITH_CASINO','OPERATING_COMPANY','RELATED_PROPERTY_HOSPITALITY_ASSET','OTHER_RELATED_INVESTMENT')),
  asset_type_other TEXT,
  asset_country TEXT NOT NULL,
  asset_name TEXT,
  asset_name_confidential INTEGER NOT NULL CHECK (asset_name_confidential IN (0,1)),
  asset_description TEXT NOT NULL,
  operating_status TEXT NOT NULL CHECK (operating_status IN ('OPERATING','TEMPORARILY_CLOSED','UNDER_DEVELOPMENT','NOT_YET_OPERATING','DISCUSS_PRIVATELY')),
  authority_declaration TEXT NOT NULL CHECK (authority_declaration IN ('YES','NO','UNSURE')),
  sale_reason TEXT CHECK (sale_reason IS NULL OR sale_reason IN ('STRATEGIC_DECISION','OWNERSHIP_CHANGE_SUCCESSION','PORTFOLIO_RESTRUCTURING','INVESTMENT_REALISATION','OTHER','DISCUSS_PRIVATELY')),
  sale_timing TEXT NOT NULL CHECK (sale_timing IN ('ASAP','WITHIN_3_MONTHS','WITHIN_6_MONTHS','WITHIN_12_MONTHS','OVER_12_MONTHS','EXPLORING')),
  asking_price_text TEXT,
  currency TEXT CHECK (currency IS NULL OR currency IN ('GBP','EUR','USD','CHF','AED','OTHER')),
  currency_other TEXT,
  additional_information TEXT,
  confidentiality_preference TEXT NOT NULL CHECK (confidentiality_preference IN ('CONTACT_BEFORE_PUBLIC_IDENTIFICATION','DISCUSS_PUBLIC_LISTING_AFTER_REVIEW','DISCUSS_WITH_BROKER')),
  privacy_notice_version TEXT NOT NULL,
  privacy_acknowledged_at TEXT NOT NULL,
  accuracy_declaration_version TEXT NOT NULL,
  accuracy_declared_at TEXT NOT NULL,
  marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0,1)),
  marketing_consent_text_version TEXT,
  marketing_consent_at TEXT,
  marketing_consent_withdrawn_at TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ASSIGNED','CONTACT_ATTEMPTED','AWAITING_SELLER','QUALIFICATION','AUTHORITY_REVIEW','QUALIFIED','CONVERTED','DECLINED','CLOSED')),
  assigned_to TEXT REFERENCES users(id),
  first_response_at TEXT,
  closed_at TEXT,
  closure_reason TEXT,
  -- Keyed HMAC of the browser-generated idempotency key; never the key itself.
  idempotency_hash TEXT NOT NULL UNIQUE,
  -- Keyed HMAC of the source IP (null when no secret/IP). Raw IPs are never stored.
  source_ip_hash TEXT,
  -- Immutable copy of the validated submission as received; later edits go to seller records, not here.
  original_submission_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  retention_review_at TEXT,
  anonymised_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_enquiries_status ON seller_enquiries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_enquiries_assignee ON seller_enquiries(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_seller_enquiries_created ON seller_enquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_enquiries_country ON seller_enquiries(asset_country, asset_type);

-- Logical-notification de-duplication on the existing durable job table (one row per logical email).
ALTER TABLE notification_jobs ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_jobs_dedupe ON notification_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
