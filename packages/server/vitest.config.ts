import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Pythonワーカー（GPU/メモリ）のリソース競合を回避するため、テストファイルを直列実行
    fileParallelism: false,
    globalSetup: '../db-engine/src/__tests__/globalSetup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
