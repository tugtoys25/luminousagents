# Product and security decisions

## Buyer registration

Buyers can self-register at `/register` with an email and optional password, but the account stays `invited` and cannot sign in until a staff member with `admin` or `super_admin` role approves it from the dashboard. Sprint 25 adds email one-time-code login as an alternative; a code-only buyer can set a password later or keep using codes. Staff can also provision a buyer directly; that buyer receives a set-password email. Approval does not grant data-room access (NDA and grants are separate). Staff must verify business identity and authority outside the platform before approving.

## Malware scanning

The platform uses a signed-result scanner adapter contract, not a built-in antivirus engine. The organisation must deploy or select a provider that accepts the exact raw object bytes and returns the documented HMAC-signed result. No document may be marked clean when scanner configuration, object hash, signature, provider, job result or audit persistence fails.

## Caching

Anonymous HTML pages use a short shared-cache TTL. APIs, staff dashboard, buyer account, health checks and `/media/*` responses are `no-store`; public media deliberately disables caching so switching an image to private takes effect immediately.

## IDs

Sprint 10 does not migrate existing primary keys to ULIDs. That is a separate schema/data migration and must not be attempted as a silent partial refactor.

## Authentication (owner decision, Sprint 25)

Custom email/password authentication remains for staff and buyers; Cloudflare Access is not required. Buyers can alternatively sign in with an email one-time code. Code-only buyers may set a password later or continue using codes. Codes expire after 10 minutes, are single-use, are rate-limited and capped at five verification attempts.

## Session pepper

`SESSION_PEPPER` is not part of the current session-token scheme: session tokens are high-entropy random values stored as SHA-256 hashes. Do not configure an unused pepper secret. If a pepper is introduced later, use a versioned token-hash migration and rotation plan rather than silently changing verification.

## Open owner decisions (Sprint 32)

Staff MFA, a separate compliance role, access tier 3 policy, the owner's blank Decision 3, which roles may change image visibility or delete referenced media, whether sold listings are a public track record, the counsel-approved NDA and signature method, and regulatory scope are **undecided** and must not be inferred by the team. They are listed with recommended defaults in `docs/SPRINT_32_OWNER_DECISIONS.md`.

## Lifecycle rules (Sprint 32)

Listing lifecycle changes follow a server-enforced transition table (`src/domain/opportunities/lifecycle.ts`, documented in `docs/SPRINT_32_COMPLETION.md`). A draft cannot jump to published; `admin` and `super_admin` have a small set of explicit correction moves. Publication still requires approved content, public classification and a verification date.

## Public redaction (Sprint 32)

For a public viewer of a confidential-price listing, every money amount in free text is withheld, not only the asking price. This is a safety net; each listing still needs human review before publication.

## P0 hardening decisions (recorded for owner confirmation)

- Staff MFA is TOTP with recovery codes, required for super_admin and admin by default; other roles optional. Previously listed as undecided; implemented as a recommended default and awaiting owner confirmation.
- Turnstile fails closed outside dev. Price parsing never guesses; ambiguous prices go to a person.
