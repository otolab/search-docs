import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['src/typescript/__tests__/**/*.test.ts'],
  },
});
