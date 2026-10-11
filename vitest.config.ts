import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    test: {
      include: ['test/**/*.test.ts'],
      // These tests read repository files with node:fs, which the Workers runtime does not
      // implement. They run in plain Node via vitest.node.config.ts instead.
      exclude: [
        ...configDefaults.exclude,
        'test/unit/*-security-invariants.test.ts',
        // Sprint 24-31 static source checks also read repository files with node:fs.
        'test/unit/sprint2[4-9]-*.test.ts',
        'test/unit/sprint3[01]-*.test.ts',
      ],
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
