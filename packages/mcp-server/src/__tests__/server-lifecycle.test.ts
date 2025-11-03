/**
 * MCP Server ライフサイクルテスト
 *
 * 目的: search-docsサーバの起動・停止、状態遷移の操作が正しく動作するかを確認する。
 *
 * 特徴: search-docsサーバを実際に起動/停止する動的なテスト
 *       各テストは独立した一時ディレクトリとポート番号を使用
 *
 * テストのコンセプト:
 * - テストの単位とプロセスの寿命を合わせる
 * - 操作（init, server_start/stop）の動作を検証
 * - 各テスト後に確実にsearch-docsサーバを停止
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolResult } from './helpers/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('MCP Server ライフサイクルテスト', () => {
  let env: TestEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      // search-docsサーバが起動している可能性があるため、
      // server_stopを試みてからクリーンアップ
      try {
        await env.tester.callTool('server_stop', {});
        // 停止完了を待機
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        // 既に停止している、または起動していない場合は無視
      }

      await env.cleanup();
      env = null;
    }
  });

  describe('init操作', () => {
    test('initツールで設定ファイルを作成できる', async () => {
      env = await setupTestEnvironment({
        prefix: 'lifecycle-init',
        createConfig: false,
        port: 54330,
      });

      const result = await env.tester.callTool('init', {
        port: 54330,
      });

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('✅ 設定ファイルの初期化が完了しました');
      expect(content).toContain('📝 設定ファイルの重要な項目');

      // 設定ファイルが実際に作成されたことを確認
      const configPath = path.join(env.testDir, '.search-docs.json');
      const configExists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(configExists).toBe(true);

      // 設定内容を確認
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.server.port).toBe(54330);
    });
  });

  describe('サーバ起動・停止', () => {
    test(
      'server_startでサーバを起動し、server_stopで停止できる',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'lifecycle-start-stop',
          createConfig: true,
          port: 54331,
          createIndexDir: false,
        });

        // 1. サーバを起動
        const startResult = await env.tester.callTool('server_start', {});
        expect(startResult.success).toBe(true);
        const startContent = (startResult.result as MCPToolResult)?.content?.[0]?.text;
        expect(startContent).toContain('✅ サーバを起動しました');

        // サーバ起動を待機
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 2. 起動後の状態確認
        const statusAfterStart = await env.tester.callTool('get_system_status', {});
        const statusContent = (statusAfterStart.result as MCPToolResult)?.content?.[0]?.text;
        expect(statusContent).toContain('状態: 稼働中');

        // 3. サーバを停止
        const stopResult = await env.tester.callTool('server_stop', {});
        expect(stopResult.success).toBe(true);
        const stopContent = (stopResult.result as MCPToolResult)?.content?.[0]?.text;
        expect(stopContent).toContain('✅ サーバを停止しました');

        // サーバ停止を待機
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 4. 停止後の状態確認
        const statusAfterStop = await env.tester.callTool('get_system_status', {});
        const statusAfterStopContent = (statusAfterStop.result as MCPToolResult)?.content?.[0]
          ?.text;
        expect(statusAfterStopContent).toContain('状態: 設定済み・サーバ停止中');
      },
      30000
    ); // 30秒のタイムアウト

    test(
      '停止後に再度server_startで起動できる',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'lifecycle-restart',
          createConfig: true,
          port: 54332,
          createIndexDir: false,
        });

        // 1. 初回起動
        await env.tester.callTool('server_start', {});
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 2. 停止
        await env.tester.callTool('server_stop', {});
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 3. 再起動
        const restartResult = await env.tester.callTool('server_start', {});
        expect(restartResult.success).toBe(true);
        const restartContent = (restartResult.result as MCPToolResult)?.content?.[0]?.text;
        expect(restartContent).toContain('✅ サーバを起動しました');

        // 再起動を待機
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 4. 再起動後の状態確認
        const statusAfterRestart = await env.tester.callTool('get_system_status', {});
        const statusContent = (statusAfterRestart.result as MCPToolResult)?.content?.[0]?.text;
        expect(statusContent).toContain('状態: 稼働中');
      },
      40000
    ); // 40秒のタイムアウト

    test(
      'サーバ起動中にserver_startを実行すると既に起動中のメッセージ',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'lifecycle-already-running',
          createConfig: true,
          port: 54333,
          createIndexDir: false,
        });

        // 1. サーバを起動
        await env.tester.callTool('server_start', {});
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 2. 既に起動中の状態でserver_startを実行
        const result = await env.tester.callTool('server_start', {});
        expect(result.success).toBe(true);
        const content = (result.result as MCPToolResult)?.content?.[0]?.text;
        expect(content).toContain('サーバは既に起動しています');
      },
      30000
    ); // 30秒のタイムアウト
  });

  describe('auto-start機能', () => {
    test(
      'インデックス存在時に自動起動される',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'lifecycle-autostart',
          createConfig: true,
          port: 54334,
          createIndexDir: true, // インデックスあり = auto-start
        });

        // auto-start完了を待機
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // auto-start後はRUNNING状態になる
        const result = await env.tester.callTool('get_system_status', {});
        expect(result.success).toBe(true);
        const content = (result.result as MCPToolResult)?.content?.[0]?.text;

        expect(content).toContain('状態: 稼働中');
        expect(content).toContain('サーバURL:');
      },
      40000
    ); // 40秒のタイムアウト（auto-start health check 30s + buffer）

    test(
      'auto-start後にserver_startを実行すると既に起動中のメッセージ',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'lifecycle-autostart-then-start',
          createConfig: true,
          port: 54335,
          createIndexDir: true,
        });

        // auto-start完了を待機
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // auto-start後にserver_startを実行
        const result = await env.tester.callTool('server_start', {});
        expect(result.success).toBe(true);
        const content = (result.result as MCPToolResult)?.content?.[0]?.text;

        expect(content).toContain('サーバは既に起動しています');
      },
      40000
    ); // 40秒のタイムアウト
  });
});
