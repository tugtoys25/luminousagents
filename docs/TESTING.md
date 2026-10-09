# Testing strategy

## Sprint 0 checks

- Worker integration tests run in the Cloudflare Workers Vitest pool.
- `GET /healthz` returns the expected minimal body.
- Security headers and request correlation are checked.
- Malformed supplied request IDs are rejected in favor of a generated ID.

## Required commands

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm format:check`
- `pnpm dev` followed by a local `/healthz` smoke test

These commands have not been executed in the current authoring environment because dependency
installation was blocked by unavailable npm registry connectivity. Treat all tests as authored but
unverified until they pass in a network-enabled environment.

## Quality gates for later sprints

- Test data repositories and services against isolated local D1/SQLite fixtures.
- Test validation failures, authorization denials, ownership scopes, redaction tiers and audit events.
- Test that confidential object retrieval is impossible without an approved grant and that revocation
  takes effect immediately.
- Use fake email providers for deterministic tests; never send real messages in unit tests.
- Add import reconciliation tests asserting all source records are accounted for and no orphan records
  remain before publication.
- Add Playwright smoke tests for public discovery, staff workflows, buyer account and denied data-room
  access; add security/accessibility/load checks before launch.
