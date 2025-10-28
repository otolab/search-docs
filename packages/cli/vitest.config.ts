import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // テストのタイムアウト設定
    testTimeout: 60000,
    hookTimeout: 60000,

    // E2Eテストは1つずつ実行
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // 出力設定: テスト失敗時のみ詳細を表示
    reporters: ['default'],

    // console出力は保持（デバッグ時に必要）
    silent: false,

    // テスト環境
    environment: 'node',
  },
});
