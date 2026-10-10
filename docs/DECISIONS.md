# Architecture decision record

## ADR-0001 — Single Cloudflare Worker

**Decision:** Use one TypeScript Worker with Hono for public pages, APIs and the future staff dashboard.

**Reason:** It matches the supplied Blueprint and keeps operational complexity low for the MVP.

## ADR-0002 — D1 is the system of record

**Decision:** Use numbered SQL migrations and repository-only SQL writes. Use KV only for cache,
configuration and rate-limit support.

**Reason:** Business state requires a durable, queryable source of truth and reviewable schema changes.

## ADR-0003 — Confidential files remain private

**Decision:** Use private R2 and stream downloads through Worker authorization checks.

**Reason:** A public object URL would bypass NDA, compliance approval and revocation checks.

## ADR-0004 — Staff identity and buyer identity are separate

**Decision (revised Sprint 16):** Staff and buyers both sign in with email + password and server-managed sessions (separate cookies and session types); staff additionally have in-app roles. Cloudflare Access and emailed one-time codes are no longer used. MFA is not yet implemented and is a recommended follow-up for staff.

**Reason:** The platform requires an owned sign-in experience while maintaining server-side staff authorization and revocable sessions.

## ADR-0005 — Legacy backend and NDA PDF are unavailable

**Decision:** Treat `secure-cm-api.php` and `NDA_New.pdf` as unavailable unless supplied later. Do not
invent their behavior or contents.

**Reason:** The supplied artifacts do not establish those files as available sources of truth.

## ADR-0006 — No false deployment claims

**Decision:** Wrangler resource identifiers remain explicit placeholders until the owner provisions
separate environments. No remote resources are created by this repository scaffold.

**Reason:** Deployment requires account access and real resource IDs. Placeholder IDs must never be
mistaken for provisioned infrastructure.

## ADR-0007 — Lockfile is a Sprint 0 follow-up blocker

**Decision:** Do not fabricate a pnpm lockfile. The authoring environment could not reach the npm
registry, so dependency resolution and a valid lockfile could not be generated or verified. CI uses `pnpm install --frozen-lockfile` and will fail closed until a real lockfile is generated and committed
in a network-enabled environment.

**Reason:** A fabricated lockfile would undermine reproducibility and supply-chain confidence.
