# Launch checklist — all gates required

- [ ] Pinned `pnpm-lock.yaml` committed; frozen install succeeds.
- [ ] Typecheck, lint, unit tests, security tests and Playwright buyer/staff E2E pass with saved logs and coverage.
- [ ] Real staging deployment and smoke tests pass for Cloudflare Access, D1, R2, KV, Queues/DLQ, Resend and Turnstile.
- [ ] Trusted scanner verifies exact SHA-256 and clean verdict; malicious, mismatched, timeout and unavailable cases fail closed.
- [ ] D1 backup and R2 object backup strategy documented; restore drill passed and evidence retained.
- [ ] OTP replay/brute-force/session expiry, CSRF, XSS, SQL injection, cache leakage, audit immutability, grant expiry/revocation and cross-buyer isolation verified.
- [ ] All legacy records reviewed; only approved records published.
- [ ] Counsel-approved privacy, terms and NDA; current NDA template seeded and hashed.
- [ ] Mobile accessibility and load/performance results recorded; alerts and error reporting tested.
- [ ] Cloudflare IDs, secrets, custom domain, Access policy and Turnstile settings verified.
- [ ] Production environment protected by required reviewers; migration and rollback rehearsed.
- [ ] Incident runbook, monitoring owner and rollback owner assigned.

Do not mark production-ready until every checkbox has evidence. Test output and staging screenshots must be attached to the release record.
