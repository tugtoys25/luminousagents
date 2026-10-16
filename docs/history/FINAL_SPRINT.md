# Final Sprint package — superseded by Sprint 10

This document describes the pre-Sprint-10 baseline. Its original scanner contract (`/v1/scans/verify`) has been replaced by the Sprint 10 raw-byte scanning adapter in `src/security/malware-scanner.ts`, which posts the exact private R2 object bytes to `/v1/scans`, recomputes SHA-256, and verifies an HMAC-authenticated provider result.

Use [`SPRINT_10.md`](SPRINT_10.md) as the current implementation and handoff source. Sprint 10 adds broker ownership/scoping, the opportunity CMS, buyer provisioning, NDA template versioning, CSP-safe styles, public caching and purge hooks, legacy seed migration 0011, broker enquiry task/notification flow, migration 0012, and encrypted D1 backup workflow.

The project remains a staging candidate, not a verified production release. The scanner engine/service is not bundled; the lockfile, Cloudflare IDs/secrets, full CI, staging verification, backup restore drill, legal approval and remaining security/accessibility/load evidence are still required.
