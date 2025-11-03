/**
 * MCP Server経由のserver start/stop 基本動作テスト
 *
 * 目的: MCPサーバ経由でのserver_start/server_stopツールの基本動作を確認する
 *
 * テスト内容:
 * 1. MCPサーバを起動（search-docsサーバは起動しない）
 * 2. server_startツールを呼び出し
 * 3. PIDファイルが作成される
 * 4. search-docsサーバプロセスが実行中
 * 5. server_stopツールを呼び出し
 * 6. search-docsサーバプロセスが停止する
 * 7. PIDファイルが削除される
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolResult } from './helpers/types.js';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('MCP Server経由 server start/stop 基本動作', () => {
  let env: TestEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      // PIDファイルが残っていたら、プロセスを停止
      const pidFilePath = path.join(env.testDir, '.search-docs', 'server.pid');
      try {
        const pidContent = await fs.readFile(pidFilePath, 'utf-8');
        const pidData = JSON.parse(pidContent);

        // プロセスが生きていたら強制終了
        try {
          process.kill(pidData.pid, 0); // プロセス存在確認
          process.kill(pidData.pid, 'SIGTERM'); // 停止
          await new Promise((resolve) => setTimeout(resolve, 1000)); // 停止待機
        } catch (error) {
          // プロセスが既に停止している場合は無視
        }
      } catch (error) {
        // PIDファイルがない場合は無視
      }

      await env.cleanup();
      env = null;
    }
  });

  test(
    'server_start→PIDファイル作成→server_stop→PIDファイル削除の完全なライフサイクル',
    async () => {
      // テスト環境をセットアップ（search-docsサーバは起動しない）
      env = await setupTestEnvironment({
        prefix: 'mcp-basic',
        createConfig: true,
        port: 54410,
        createIndexDir: false, // auto-startしない
      });

      const pidFilePath = path.join(env.testDir, '.search-docs', 'server.pid');

      // 1. server_startツールを呼び出し
      const startResult = await env.tester.callTool('server_start', {});
      expect(startResult.success).toBe(true);
      const startContent = (startResult.result as MCPToolResult)?.content?.[0]?.text;
      expect(startContent).toContain('✅ サーバを起動しました');

      // サーバ起動を待機
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 2. PIDファイルが作成されていることを確認
      const pidFileExists = await fs
        .access(pidFilePath)
        .then(() => true)
        .catch(() => false);
      expect(pidFileExists).toBe(true);

      // 3. PIDファイルの内容を確認
      const pidContent = await fs.readFile(pidFilePath, 'utf-8');
      const pidData = JSON.parse(pidContent);

      expect(pidData).toHaveProperty('pid');
      expect(pidData).toHaveProperty('port');
      expect(pidData.port).toBe(54410);
      expect(pidData).toHaveProperty('projectRoot');
      // macOSでは/tmpは/private/tmpへのシンボリックリンクなので、両方を許容
      const normalizedProjectRoot = pidData.projectRoot.replace('/private', '');
      const normalizedTestDir = env.testDir.replace('/private', '');
      expect(normalizedProjectRoot).toBe(normalizedTestDir);

      // 4. プロセスが実行中であることを確認
      let processExists = false;
      try {
        process.kill(pidData.pid, 0); // シグナル0で存在確認のみ
        processExists = true;
      } catch (error) {
        processExists = false;
      }
      expect(processExists).toBe(true);

      // 5. server_stopツールを呼び出し
      const stopResult = await env.tester.callTool('server_stop', {});
      expect(stopResult.success).toBe(true);
      const stopContent = (stopResult.result as MCPToolResult)?.content?.[0]?.text;
      expect(stopContent).toContain('✅ サーバを停止しました');

      // 停止完了を待機
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 6. プロセスが停止していることを確認
      let processStopped = false;
      try {
        process.kill(pidData.pid, 0);
        processStopped = false;
      } catch (error) {
        processStopped = true;
      }
      expect(processStopped).toBe(true);

      // 7. PIDファイルが削除されていることを確認
      const pidFileDeleted = await fs
        .access(pidFilePath)
        .then(() => false)
        .catch(() => true);
      expect(pidFileDeleted).toBe(true);
    },
    30000
  ); // 30秒のタイムアウト
});
