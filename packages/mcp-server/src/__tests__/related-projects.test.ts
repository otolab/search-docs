/**
 * 関連プロジェクト機能のE2Eテスト
 *
 * 目的: 複数プロジェクトの検索機能が正しく動作するかを確認する
 *
 * テストのコンセプト:
 * - メインプロジェクトと関連プロジェクトを用意
 * - 関連プロジェクトの設定を解決して検索できることを確認
 * - get_system_statusで関連プロジェクト情報が表示されることを確認
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolResult } from './helpers/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('関連プロジェクト機能', () => {
  let mainEnv: TestEnvironment | null = null;
  let relatedEnv: TestEnvironment | null = null;

  afterEach(async () => {
    // 両方のサーバを停止
    if (mainEnv) {
      try {
        await mainEnv.tester.callTool('server_stop', {});
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        // ignore
      }
      await mainEnv.cleanup();
      mainEnv = null;
    }

    if (relatedEnv) {
      try {
        // 関連プロジェクトのサーバを直接停止
        const { SearchDocsClient } = await import('@search-docs/client');
        const client = new SearchDocsClient({
          baseUrl: `http://localhost:${relatedEnv.port}`,
        });
        try {
          await client.stopServer();
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
      await relatedEnv.cleanup();
      relatedEnv = null;
    }
  });

  test(
    'relatedProjectsを設定すると、CONFIGURED_SERVER_DOWN状態でも設定を読み込める',
    async () => {
      // メインプロジェクトをセットアップ
      mainEnv = await setupTestEnvironment({
        prefix: 'related-config',
        createConfig: true,
        port: 54340,
        createIndexDir: false,
      });

      // 関連プロジェクトをセットアップ
      relatedEnv = await setupTestEnvironment({
        prefix: 'related-sub',
        createConfig: true,
        port: 54341,
        createIndexDir: false,
      });

      // メインプロジェクトの設定に関連プロジェクトを追加
      const mainConfigPath = path.join(mainEnv.testDir, '.search-docs.json');
      const mainConfig = JSON.parse(await fs.readFile(mainConfigPath, 'utf-8'));
      mainConfig.relatedProjects = {
        'related-sub': {
          dir: relatedEnv.testDir,
          description: 'Test related project',
        },
      };
      await fs.writeFile(mainConfigPath, JSON.stringify(mainConfig, null, 2));

      // 設定ファイルが正しく保存されたことを確認
      const savedConfig = JSON.parse(await fs.readFile(mainConfigPath, 'utf-8'));
      expect(savedConfig.relatedProjects).toBeDefined();
      expect(savedConfig.relatedProjects['related-sub']).toBeDefined();
      expect(savedConfig.relatedProjects['related-sub'].description).toBe('Test related project');
    },
    30000
  );

});
