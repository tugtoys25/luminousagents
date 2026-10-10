import { applyD1Migrations, env } from 'cloudflare:test';

// Apply every D1 migration to the isolated test database before each test file.
const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
  .TEST_MIGRATIONS;
await applyD1Migrations(env.DB, migrations);
