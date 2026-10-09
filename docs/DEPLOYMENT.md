# Deployment and provisioning

## Before deploying

The repository currently has placeholder IDs for D1 and KV. Do not deploy until all placeholders are
replaced with actual resources and reviewed. Create separate resources for development, staging and
production; ensure the R2 buckets are private and public access is disabled.

Provision for each environment:

- D1 database and its actual database ID.
- Private R2 bucket.
- KV namespace and its actual namespace ID.
- Notifications and audit queues. The notification queue consumer is configured in `wrangler.jsonc`; create the queue resources before deployment and verify the consumer and cron recovery schedule in staging. Audit queue consumer behavior is not implemented.
- Cloudflare Worker permissions and the intended custom domain/route.

Update `wrangler.jsonc` with the actual IDs/names. Keep non-secret identifiers in reviewed config and
credentials in Wrangler/GitHub secrets. Never paste secret values into source code or chat.

## GitHub Actions secrets and protections

- `CLOUDFLARE_API_TOKEN`: least-privilege token for the intended environment resources.
- `CLOUDFLARE_ACCOUNT_ID`: target account identifier.
- `staging` environment: restrict deployment to the intended branch and maintain deployment history.
- `production` environment: required reviewer approval, restricted tags, and least-privilege credentials.

The production workflow accepts a version tag (`v*`) or manual dispatch and uses the protected GitHub
`production` environment. Configure required reviewers and tag restrictions in GitHub repository settings.
Staging CI is wired but cannot be considered operational until the resources and secrets are configured
and a real deployment is verified.

## Application secrets (later sprints)

Configure only for the environments where the corresponding feature is enabled:

- Turnstile secret key.
- Resend/email provider API key and verified sender/domain (`RESEND_API_KEY` secret, `EMAIL_FROM` and `OPS_EMAIL` configuration).
- `OTP_ENCRYPTION_KEY` (base64 of 32 random bytes), rotated independently per environment.
- `PUBLIC_BASE_URL` for links in outgoing notifications.
- Session HMAC/secret material with a documented rotation plan.
- Cloudflare Access team domain and expected application audience.

Use Wrangler secrets for local/remote Worker secret values and GitHub environment secrets for deploy
credentials. Keep `.dev.vars` local and untracked. Use separate secret values per environment.

## Domains and legal launch gates

Domain/DNS/TLS, email sender verification, staff identity/access policies, company notices, privacy,
terms, cookie handling and legal approval are deployment/launch requirements. No domain cut-over should
occur until old URLs and redirects have been tested and the legal/content review is complete.
