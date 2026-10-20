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
      // Several repo tests run many ordered steps inside one `it` and took 6 to 7 seconds on a busy
      // CI runner, past the 5 second default. A longer limit only stops false timeouts.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
