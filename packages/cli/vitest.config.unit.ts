import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/commands/config/__tests__/**/*.test.ts',
      'src/commands/embedding/__tests__/**/*.test.ts',
      'src/utils/__tests__/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
