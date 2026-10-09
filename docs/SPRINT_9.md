# Casinos of Mayfair — Sprint 9

## Buyer and staff workflow verification

### Objective

Exercise buyer data-room access through actual Cloudflare Worker requests, covering unauthenticated users, expired access, revoked grants, active grants, download auditing/cache controls, scan-state gating, and staff NDA endpoint authentication.

### Added deliverables

- `test/buyer-staff-workflows.e2e.test.ts`: Worker-level E2E suite using the configured `cloudflare:test` D1/R2/KV bindings and `SELF.fetch`.
- `scripts/sprint9-workflow-gate.mjs`: source invariants plus test-run gate. It exits non-zero if required tests/source are missing, dependencies are unavailable, or tests fail.
- `pnpm test:e2e:buyer-staff`: focused execution command.

### Scenarios covered

1. Buyer document listing and download without a session return 401.
2. Expired grants cannot list or download documents.
3. Revoked grants cannot list documents.
4. An active grant can list and download an approved, published opportunity's clean document.
5. Downloads use `Cache-Control: private, no-store`.
6. A document moved back to `pending` is hidden from listing and direct download returns 404.
7. Staff NDA API rejects requests without a verified Cloudflare Access identity (401 or 503 if Access is not configured in test bindings).

### Run

```sh
pnpm install
pnpm test:e2e:buyer-staff
pnpm test
pnpm typecheck
pnpm lint
pnpm preflight:sprint9
```

### Limitations and acceptance requirements

- These tests exercise the Worker routes against local test bindings; they are not a substitute for browser-driven verification of the sign-in email code, browser cookie behavior, staff UI, or live queue delivery.
- Staff approval/rejection with a cryptographically valid Cloudflare Access JWT must be verified in staging because the app intentionally validates JWT signatures against Cloudflare Access JWKS.
- Run a second buyer account against another buyer's opportunity/document to prove cross-account isolation in staging and add any uncovered regression as an automated test.
- Test expired buyer sessions, suspended buyer accounts, insufficient document tier, unpublished/unapproved opportunities, missing R2 objects, and audit event creation before release.
- The test suite requires migrations to be applied by the Cloudflare Vitest worker pool and may need fixture adjustments if the schema changes.
- Do not call this sprint complete until the commands above produce saved CI logs and the staging checklist is signed off.
