import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/args.test.ts',
      'src/__tests__/state.test.ts',
      'src/__tests__/server-manager-related.test.ts',
      'src/tools/__tests__/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
