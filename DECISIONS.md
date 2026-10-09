# Product and security decisions

## Buyer registration

Public self-registration is disabled. A staff member with `admin` or `super_admin` role provisions a buyer from the dashboard. Provisioned buyers sign in using the existing email one-time-code flow; access remains dependent on email delivery and account status. Staff must verify business identity and authority outside the platform before provisioning.

## Malware scanning

The platform uses a signed-result scanner adapter contract, not a built-in antivirus engine. The organisation must deploy or select a provider that accepts the exact raw object bytes and returns the documented HMAC-signed result. No document may be marked clean when scanner configuration, object hash, signature, provider, job result or audit persistence fails.

## Caching

Anonymous GET pages use a short 60-second shared-cache TTL. APIs, staff dashboard, buyer account and health checks remain `no-store`. Cache invalidation is bounded by TTL; deployments requiring immediate purge must add a provider purge integration before launch.

## IDs

Sprint 10 does not migrate existing primary keys to ULIDs. That is a separate schema/data migration and must not be attempted as a silent partial refactor.

## Session pepper

`SESSION_PEPPER` is not part of the current session-token scheme: session tokens are high-entropy random values stored as SHA-256 hashes. Do not configure an unused pepper secret. If a pepper is introduced later, use a versioned token-hash migration and rotation plan rather than silently changing verification.
