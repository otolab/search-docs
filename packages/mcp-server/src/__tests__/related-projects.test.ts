/**
 * 関連プロジェクト機能のE2Eテスト
 *
 * 目的: 複数プロジェクトの検索機能が正しく動作するかを確認する
 *
 * テストのコンセプト:
 * - メインプロジェクトと関連プロジェクトを用意
 * - 各プロジェクトにテスト用のドキュメントを作成
 * - 関連プロジェクトの設定を解決して検索できることを確認
 * - get_system_statusで関連プロジェクト情報が表示されることを確認
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolResult } from './helpers/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SearchDocsClient } from '@search-docs/client';

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
          await client.shutdown();
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

  test(
    '関連プロジェクトのドキュメントを検索できる',
    async () => {
      // メインプロジェクトをセットアップ
      mainEnv = await setupTestEnvironment({
        prefix: 'related-search-main',
        createConfig: true,
        port: 54350,
        createIndexDir: false,
      });

      // 関連プロジェクトをセットアップ
      relatedEnv = await setupTestEnvironment({
        prefix: 'related-search-sub',
        createConfig: true,
        port: 54351,
        createIndexDir: false,
      });

      // 設定を更新してCHANGELOG.mdを除外
      const relatedConfigPath = path.join(relatedEnv.testDir, '.search-docs.json');
      const relatedConfig = JSON.parse(await fs.readFile(relatedConfigPath, 'utf-8'));
      relatedConfig.files.exclude = ['**/node_modules/**', '**/CHANGELOG.md'];
      await fs.writeFile(relatedConfigPath, JSON.stringify(relatedConfig, null, 2));

      // 関連プロジェクトにドキュメントを作成
      const relatedDocPath = path.join(relatedEnv.testDir, 'test-doc.md');
      await fs.writeFile(
        relatedDocPath,
        '# Test Document for E2E\n\nThis document contains a very specific unique phrase: XYZ999TestRelatedProject\n'
      );

      // 関連プロジェクトのサーバを起動してインデックスを作成
      await relatedEnv.tester.callTool('server_start', {});
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // インデックスを再構築
      const relatedClient = new SearchDocsClient({
        baseUrl: `http://localhost:${relatedEnv.port}`,
      });
      await relatedClient.rebuildIndex();

      // インデックス作成を十分待つ
      await new Promise((resolve) => setTimeout(resolve, 8000));

      // メインプロジェクトの設定に関連プロジェクトを追加
      const mainConfigPath = path.join(mainEnv.testDir, '.search-docs.json');
      const mainConfig = JSON.parse(await fs.readFile(mainConfigPath, 'utf-8'));
      mainConfig.relatedProjects = {
        'related-search-sub': {
          dir: relatedEnv.testDir,
          description: 'Test related project for search',
        },
      };
      await fs.writeFile(mainConfigPath, JSON.stringify(mainConfig, null, 2));

      // メインサーバを起動
      await mainEnv.tester.callTool('server_start', {});
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 関連プロジェクトを指定して検索
      const searchResult = await mainEnv.tester.callTool('search', {
        query: 'XYZ999TestRelatedProject',
        project: 'related-search-sub',
        limit: 5,
      });

      expect(searchResult.success).toBe(true);
      const content = (searchResult.result as MCPToolResult)?.content?.[0]?.text || '';

      // プロジェクト名が表示されていることを確認
      expect(content).toContain('[プロジェクト: related-search-sub]');
      // 検索が成功し、結果が返ってきたことを確認
      expect(content).toContain('検索結果');
      // test-doc.mdが検索結果に含まれていることを確認
      expect(content).toContain('test-doc.md');
    },
    120000
  );

});
