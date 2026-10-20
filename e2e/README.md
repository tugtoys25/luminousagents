# Staging end-to-end suite

These checks run against a deployed **staging** Worker. They have not been executed in this repository's
build environment (no browser and no network were available), so treat them as unproven until they have run
green in your CI.

```
cd e2e
npm install            # separate from the root pnpm install on purpose
npx playwright install chromium
E2E_BASE_URL=https://your-staging-host npm test
```

Optional environment variables unlock signed-in checks (they are skipped, and reported as skipped, without them):
`E2E_BUYER_EMAIL`, `E2E_BUYER_PASSWORD`, `E2E_STAFF_EMAIL`, `E2E_STAFF_PASSWORD`, `E2E_BROKER_EMAIL`,
`E2E_BROKER_PASSWORD`, `E2E_OTHER_OPPORTUNITY_ID`. Use dedicated test accounts, never real customer accounts.

Not automated here, and still manual before launch: Turnstile-protected enquiry submission (use Cloudflare's
documented test keys on staging), real email delivery, a clean/malicious scanner round-trip, NDA signing and
approval, and the full buyer-to-document download journey. See `docs/SPRINT_32_COMPLETION.md`.

## Seller workflow checks
`tests/seller-workflow.spec.ts` covers the public `/sell-a-casino` page (no upload, privacy link, conditional fields, refusal of oversized or non-JSON bodies), anonymous refusal on every seller route, and admin/broker access boundaries. These have **not been executed**. The two submission tests need `E2E_TURNSTILE_TEST_KEYS=yes` (a staging Worker configured with Cloudflare's documented always-pass test keys) and create a synthetic enquiry on staging. The full staff journey (qualify, convert, verify authority, publish, material-interest notice) is deliberately **not** automated here because it needs MFA, a second approver and real email; follow the manual smoke tests in `docs/SELLER_OPERATIONS_RUNBOOK.md`.
