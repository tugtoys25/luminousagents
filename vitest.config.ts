import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // These tests read repository files with node:fs, which the Workers runtime does not
    // implement. They run in plain Node via vitest.node.config.ts instead.
    exclude: [...configDefaults.exclude, 'test/unit/*-security-invariants.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
