/**
 * MCP Server ライフサイクルテスト
 *
 * 目的: init操作とauto-start機能が正しく動作するかを確認する。
 *
 * 特徴: 各テストは独立した一時ディレクトリとポート番号を使用
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
      expect(content).toContain('設定リファレンス');
    });

    test('既存設定がある場合はforce:falseで上書きせず警告を返す', async () => {
      env = await setupTestEnvironment({
        prefix: 'lifecycle-init-existing',
        createConfig: true,
        port: 54331,
      });

      const configPath = path.join(env.testDir, '.search-docs.json');
      const originalContent = await fs.readFile(configPath, 'utf-8');

      const result = await env.tester.callTool('init', {
        port: 54332,
        force: false,
      });

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('⚠️');
      expect(content).toContain('既存の設定は変更されていません');
      expect(content).not.toContain('✅ 設定ファイルの初期化が完了しました');
      expect(await fs.readFile(configPath, 'utf-8')).toBe(originalContent);
    });
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
      },
      40000
    );
  });
});
