import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['src/maintenance/__tests__/**/*.test.ts'],
  },
});
