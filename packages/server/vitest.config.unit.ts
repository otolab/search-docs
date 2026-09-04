import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/splitter/__tests__/**/*.test.ts',
      'src/discovery/__tests__/**/*.test.ts',
      'src/__tests__/watcher-process.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
