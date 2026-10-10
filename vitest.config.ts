import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli.ts self-invokes and hits a live exchange; exercised by hand, not unit-tested.
      exclude: ['src/cli.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 98,
        branches: 94,
        functions: 100,
        lines: 100,
      },
    },
  },
});