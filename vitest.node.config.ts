import { defineConfig } from 'vitest/config';

// Static source/migration invariant checks that need the real filesystem.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/unit/*-security-invariants.test.ts',
      'test/unit/sprint2[4-9]-*.test.ts',
      'test/unit/sprint3[01]-*.test.ts',
    ],
  },
});
