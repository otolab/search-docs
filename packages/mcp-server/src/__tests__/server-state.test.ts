/**
 * MCP Server 状態確認テスト
 *
 * 目的: 各状態（NOT_CONFIGURED, CONFIGURED_SERVER_DOWN, RUNNING）において、
 *       利用可能なツールとget_system_statusの内容が正しいかを確認する。
 *
 * 特徴: search-docsサーバを起動/停止しない静的なテスト
 *       各テストは独立した一時ディレクトリとポート番号を使用
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolsListResponse, MCPToolResult } from './helpers/types.js';

describe('MCP Server 状態確認テスト', () => {
  let env: TestEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('NOT_CONFIGURED状態', () => {
    test('利用可能なツールはinit, get_system_statusのみ', async () => {
      env = await setupTestEnvironment({
        prefix: 'state-not-configured',
        createConfig: false,
        port: 54320,
      });

      const response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
      const toolNames = response.tools.map((t) => t.name);

      // NOT_CONFIGURED状態では init と get_system_status のみ利用可能
      expect(toolNames).toContain('init');
      expect(toolNames).toContain('get_system_status');

      // 他のツールは利用不可
      expect(toolNames).not.toContain('server_start');
      expect(toolNames).not.toContain('server_stop');
      expect(toolNames).not.toContain('search');
      expect(toolNames).not.toContain('get_document');
      expect(toolNames).not.toContain('index_status');
    });

    test('get_system_statusで未設定状態を確認', async () => {
      env = await setupTestEnvironment({
        prefix: 'state-not-configured-status',
        createConfig: false,
        port: 54320,
      });

      const result = await env.tester.callTool('get_system_status', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toBeDefined();
      expect(content).toContain('状態: 未設定');
    });
  });

  describe('CONFIGURED_SERVER_DOWN状態', () => {
    test('全ツールが利用可能', async () => {
      env = await setupTestEnvironment({
        prefix: 'state-configured-down',
        createConfig: true,
        port: 54321,
        createIndexDir: false, // インデックスなし = auto-startしない
      });

      const response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
      const toolNames = response.tools.map((t) => t.name);

      // CONFIGURED状態では全ツールが利用可能
      expect(toolNames).toContain('init');
      expect(toolNames).toContain('server_start');
      expect(toolNames).toContain('server_stop');
      expect(toolNames).toContain('get_system_status');
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('get_document');
      expect(toolNames).toContain('index_status');
    });

    test('get_system_statusで設定済み・サーバ停止中状態を確認', async () => {
      env = await setupTestEnvironment({
        prefix: 'state-configured-down-status',
        createConfig: true,
        port: 54321,
        createIndexDir: false,
      });

      const result = await env.tester.callTool('get_system_status', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('状態: 設定済み・サーバ停止中');
    });
  });

  describe('RUNNING状態（auto-start後）', () => {
    test(
      '全ツールが利用可能',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'state-running',
          createConfig: true,
          port: 54322,
          createIndexDir: true, // インデックスあり = auto-start
        });

        // auto-start完了を待機
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
        const toolNames = response.tools.map((t) => t.name);

        // RUNNING状態では全ツールが利用可能
        expect(toolNames).toContain('init');
        expect(toolNames).toContain('server_start');
        expect(toolNames).toContain('server_stop');
        expect(toolNames).toContain('get_system_status');
        expect(toolNames).toContain('search');
        expect(toolNames).toContain('get_document');
        expect(toolNames).toContain('index_status');
      },
      40000
    ); // 40秒のタイムアウト（auto-start health check 30s + buffer）

    test(
      'get_system_statusで稼働中状態を確認',
      async () => {
        env = await setupTestEnvironment({
          prefix: 'state-running-status',
          createConfig: true,
          port: 54322,
          createIndexDir: true,
        });

        // auto-start完了を待機
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const result = await env.tester.callTool('get_system_status', {});

        expect(result.success).toBe(true);
        const content = (result.result as MCPToolResult)?.content?.[0]?.text;

        expect(content).toContain('状態: 稼働中');
        expect(content).toContain('サーバURL:');
      },
      40000
    ); // 40秒のタイムアウト（auto-start health check 30s + buffer）
  });
});
