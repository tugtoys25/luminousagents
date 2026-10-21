# Seller workflow: deployment and operations runbook

Companion to `docs/SELLER_WORKFLOW.md`. Nothing in this runbook has been executed by the author; every step is for you to perform and record.

## 1. Required configuration
Many of the seller settings below can now be changed in **Dashboard > Seller settings** instead of the environment; a saved value overrides the environment variable, and Reset returns to it. Sensitive ones need a super admin and recent MFA.
Existing (must already be set for staging and production): `IP_HASH_SECRET`, Turnstile site and secret keys, `RESEND_API_KEY`, `EMAIL_FROM`, `OTP_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`.
Seller workflow (see `.dev.vars.example`): `SELLER_ALERT_RECIPIENTS` (**required**, internal alerts), `SELLER_EMAIL_FROM` (verified sender; falls back to `EMAIL_FROM`), `SELLER_REPLY_TO`, `SELLER_COMPANY_WEBSITE`, `SELLER_ALERT_INCLUDE_PHONE`, `SELLER_ALERT_INCLUDE_PRICE`, `SELLER_MARKETING_CONSENT_ENABLED` (leave off until legal review), `SELLER_REMINDERS_ENABLED`, `SELLER_REMINDER_INTERVAL_HOURS`, `SELLER_ESCALATION_AFTER_HOURS`, `SELLER_ESCALATION_RECIPIENTS`, `SELLER_SEPARATION_OF_DUTIES` (default on), `SELLER_MATERIAL_INTEREST_DUAL_APPROVAL` (default off), `SELLER_RETENTION_REVIEW_DAYS` (unset until approved). Do not invent addresses or periods.

## 2. Release steps
1. Take a D1 backup/export; confirm you can restore it (see the repository's existing restore-drill docs).
2. Apply migrations to **staging** (`wrangler d1 migrations apply` as your repo documents): 0032 to 0043. Confirm the trigger migrations (0033, 0035, 0037, 0039, 0040, 0043) applied without error.
3. Deploy to staging and run the smoke tests below. 4. Repeat on production in a quiet period.

## 3. Staging smoke tests (record results)
- Public: open `/sell-a-casino`; submit with a bad email (clear field error, nothing stored); submit valid (reference shown); submit the same page twice (one record). Confirm Turnstile rejects a missing token.
- Email: the acknowledgement arrives from the configured sender; the internal alert reaches `SELLER_ALERT_RECIPIENTS` and omits description and (by default) phone and price. Check notification jobs show `sent` and the communication history shows "accepted by provider".
- Failure handling: temporarily unset the Resend key; submit; confirm the enquiry is stored and jobs retry then go `dead` visibly; restore and re-enqueue via the recovery cron.
- Staff: assign, status transitions (invalid ones rejected), notes, communication, follow-up task and reminder.
- Authority and publication: create seller from a qualified enquiry; convert; confirm publication is refused (HTTP 409 with reasons) until authority, mandate, confidentiality review and publication review are complete and the verifier differs from the recorder; confirm revoking authority withdraws a live listing and clears the public cache.
- Material interest: approve, draft, preview, send; confirm the email contains only approved text; withdraw before sending and confirm nothing is sent.
- Privacy: log a request; place and release a hold; anonymise a test enquiry; export as super admin.
- Access: a broker cannot open another broker's enquiry, seller, interest or message (404); publisher and editor have no seller access.

## 4. Email operations
Templates (all HTML plus plain text, escaped; id includes version): `seller_enquiry_received_v1` (auto, fixed content), `seller_enquiry_internal_alert_v1` (auto, data-minimising), `seller_enquiry_followup_v1` (staff, previewed and confirmed), `seller_material_interest_v1` (approver, previewed and confirmed, eligibility re-checked at dispatch), `seller_followup_due_v1` (scheduled reminder), `seller_enquiry_assigned_v1` (internal, to the new owner). Each logical email has a unique outbox key (ack and alert per enquiry, follow-up and notice per message, reminder per task window), so retries, redelivery, restarts and double-clicks cannot duplicate it. Transient failures retry with backoff (max 5 attempts); permanent 4xx failures go straight to `dead`. To change wording, add a new template version and new id; historical messages keep their stored content and template id. There is no in-app test-send: use staging with real recipients you control.
Failure recovery: dead jobs appear in the existing notification monitor; fix the cause (recipient, sender, key), then re-enqueue per the repository's existing procedure. A material-interest message that was cancelled for ineligibility must be re-drafted, never re-sent.

## 4a. Authority evidence operations
Set up the existing scanner first (see `docs/NDA_AND_DATAROOM.md`), then confirm the platform scanner mode is not `disabled` in production. Smoke test on staging: upload a small PDF to an authority record; confirm it shows "awaiting scan; unavailable" and cannot be downloaded; scan it; confirm the download needs MFA, works for admin/compliance, is refused for a broker, and produces an access-log and audit entry; upload an EICAR test file to confirm rejection (scanner permitting); delete a file and confirm the R2 object is gone and the name is redacted; try to verify an authority with no reference and no clean file and confirm it is refused. Review `seller_evidence_access_log` (and audit actions `authority.evidence_*`) periodically; unexpected downloads by one person should be investigated. If `seller_evidence_purge_failed` appears in logs, check R2 availability; rows stay pending and retry on the next run.

## 5. Scheduled work
The existing cron runs, in order: evidence purge, authority expiry sweep, seller reminders, notification recovery. Reminders are idempotent per task window; escalation fires once per task. If a job fails it logs `seller_authority_expiry_failed` or `seller_reminders_failed`; check these after each release. Overdue follow-ups are visible in the inbox filter "Follow-up: overdue".

## 6. Permissions summary
Closing and declining an enquiry also needs recent MFA. Broker: own enquiries and sellers only; can record, draft, request review. Admin and super admin: assign, close, verify authority (MFA), approve and send material-interest notices (MFA), review links, retention and privacy tools. Publisher: approve or revoke publication reviews. Super admin only: export. Compliance: reads all seller records, verifies authority and downloads evidence (MFA), cannot send, assign, close, publish or retain. Editors, auditors: no seller access (auditors see seller audit entries via the existing audit screen). Separation of duties (verifier and publication approver differ from the preparer) is on by default. A team with one admin should add a `compliance` user as the verifier rather than switching it off; switching it off is a sensitive setting (super admin, MFA).

## 7. Audit review
Review `audit_logs` entries with actions beginning `seller_`, `authority.`, `material_interest.`, `privacy_request.`, `opportunity.created_from_seller_enquiry` and `seller_publication.`. Also review `seller.permission_denied` and `seller.step_up_required` (repeated denials by one person). Look for: unexpected `authority.*_withdrew_listing`, `seller_message.cancelled_ineligible`, `seller_enquiry.exported` and `seller_enquiry.anonymised` events. Audit rows are append-only by trigger and carry no personal data or message content.

## 8. Retention and privacy requests
Retention is staff-driven. Until the business approves a period and sets `SELLER_RETENTION_REVIEW_DAYS`, the review list is empty by design. For each candidate: check for legal or regulatory duties and any open dispute, place a hold if needed, otherwise anonymise (irreversible). Enquiries linked to a seller are erased through the seller: set the seller INACTIVE (after ending relationships and closing enquiries and interests), then anonymise it; the tool refuses while anything is live, open or held. Log every privacy request and record its outcome; due dates come from your policy.

## 9. Backup, recovery, rollback
Back up before each migration. Migrations are forward-only and additive. To disable the feature without data loss, remove the routes' mounting in `src/admin/routes.ts` and `src/index.ts` (public form) and leave tables in place. Trigger rollback is documented in each trigger migration header. The publication-gate trigger (0037) can be dropped to restore the previous publication behaviour, but then seller-sourced listings are no longer protected in the database.

## 10. Production release checklist
- [ ] CI green: typecheck, lint, tests (including migrations on real D1). - [ ] Staging smoke tests recorded. - [ ] Provider sender verified (SPF/DKIM) and Turnstile verified on staging. - [ ] `SELLER_ALERT_RECIPIENTS` and sender configured. - [ ] Legal review of privacy notice, declarations, consent, retention and cross-border processing. - [ ] Roles reviewed (who is admin, publisher, super admin). - [ ] Backup taken and restore tested. - [ ] Existing publish and unpublish flows re-tested after migration 0037.
