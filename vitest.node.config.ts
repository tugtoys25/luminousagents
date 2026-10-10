import { defineConfig } from 'vitest/config';

// Static source/migration invariant checks that need the real filesystem.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/*-security-invariants.test.ts'],
  },
});
