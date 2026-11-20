import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/embedding/__tests__/openai-integration.test.ts'],
    fileParallelism: false,
  },
});
