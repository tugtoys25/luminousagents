# Backups and restore drill

## Automated D1 backups

The `nightly-backup.yml` workflow exports both staging and production D1, encrypts the SQL export with GPG AES-256 using the `BACKUP_ENCRYPTION_PASSPHRASE` environment secret, and uploads the encrypted file to a private R2 bucket. Configure the GitHub `staging` and `production-backup` environments with Cloudflare credentials and the passphrase; keep the separate `production` deployment environment protected with human approval. Create private buckets named `mayfair-backups-staging` and `mayfair-backups-production`; do not enable public access. Require human approval on the production GitHub environment.

The workflow is code only until a successful run is evidenced. It depends on the committed lockfile, configured Cloudflare resources, correct Wrangler CLI syntax for the deployed version, and environment secrets. It does not currently back up private R2 deal documents; define and test an independent R2 replication/retention policy before production.

## Restore drill (must be performed and recorded by the team)

**Automated first pass:** run the `Restore drill` workflow (`restore-drill.yml`). It fetches the newest encrypted snapshot, decrypts it on the runner, loads it into throw-away in-memory SQLite and runs `scripts/restore-verify.mjs` (required tables, 198+ listings, no unreviewed listing public, foreign keys, integrity). Locally: `node scripts/restore-verify.mjs export.sql`. A pass proves the snapshot loads and is consistent; the manual steps below are still needed for a full restore into a staging D1 and smoke test. Record each drill in the table at the bottom.


1. Select an encrypted staging snapshot from private R2 and verify object metadata and age.
2. Decrypt it in a controlled runner using the secret passphrase; never commit the passphrase or plaintext export.
3. Create a disposable D1 database and import the SQL into it, or restore into an isolated staging database after an approved maintenance window.
4. Apply migrations as required, then verify table counts, 198 legacy records, `pending` review status, zero public visibility on unreviewed records, users/sessions, NDA grants, and document metadata.
5. Run buyer/staff smoke tests, compare representative records, and document duration, row counts, any data loss window, operator, timestamp, snapshot key, and cleanup.
6. Delete disposable plaintext exports and test databases according to policy. Do not claim restore readiness until the drill passes.

## D1 Time Travel

Enable and document Cloudflare D1 Time Travel retention appropriate to the subscription and regulatory needs. Record the point-in-time recovery window and restore commands for each environment. Time Travel is not a substitute for independent encrypted backups or R2 document backup.

## Drill log

| Date | Environment | Snapshot key | Result | Duration | Operator |
| ---- | ----------- | ------------ | ------ | -------- | -------- |
|      |             |              |        |          |          |

## Deploy ordering

`deploy.yml` and `deploy-production.yml` apply D1 migrations (`wrangler d1 migrations apply`) before deploying code, because the Worker queries tables and columns added by the newest migration (for example `staff_mfa`, `sessions.mfa_at`). Never deploy code ahead of its migration. Migrations are additive; to roll back a release, redeploy the previous Worker version, leave the schema in place.
