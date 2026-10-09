#!/usr/bin/env bash
# One-time resource creation helper. Review names and ensure you are logged into the intended Cloudflare account.
set -euo pipefail
command -v pnpm >/dev/null || { echo 'Install the pinned pnpm version first.' >&2; exit 1; }
for env in dev staging production; do
  echo "Creating D1 for $env; save the returned database_id and update wrangler.jsonc"
  pnpm exec wrangler d1 create "mayfair-platform-$env"
  echo "Creating KV namespace for $env; save the returned id and update wrangler.jsonc"
  pnpm exec wrangler kv namespace create "mayfair-platform-cache-$env"
  echo "Creating private R2 bucket for $env"
  pnpm exec wrangler r2 bucket create "mayfair-platform-private-$env"
  echo "Creating queues for $env"
  pnpm exec wrangler queues create "mayfair-notifications-$env"
  pnpm exec wrangler queues create "mayfair-notifications-$env-dlq"
done
for env in staging production; do
  pnpm exec wrangler r2 bucket create "mayfair-backups-$env"
done
cat <<'MSG'
Resources created only if the commands succeeded. Update each D1 and KV ID in wrangler.jsonc,
then set secrets with `pnpm exec wrangler secret put NAME --env staging` and `--env production`.
Create Cloudflare Access applications, bind the right hostnames, and verify queues/DLQs before deploy.
Do not enable public access on private document or backup buckets.
MSG
