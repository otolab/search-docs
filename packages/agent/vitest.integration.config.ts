import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // モデル推論は直列で実行
    fileParallelism: false,
    // モデルロード + 推論に時間がかかる（初回はモデルDL含む）
    testTimeout: 300_000,
  },
});
