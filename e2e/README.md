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
