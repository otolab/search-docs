/**
 * 動的ツール更新テスト
 *
 * 目的: 状態遷移時にツールリストが動的に更新されることを確認する
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolsListResponse } from './helpers/types.js';

describe('動的ツール更新テスト', () => {
  let env: TestEnvironment | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  test('init実行後にserver_startが利用可能になる', async () => {
    // NOT_CONFIGURED状態で起動
    env = await setupTestEnvironment({
      prefix: 'dynamic-init',
      createConfig: false,
      port: 54330,
    });

    // 初期状態: init, get_system_status のみ
    let response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
    let toolNames = response.tools.map((t) => t.name);

    expect(toolNames).toContain('init');
    expect(toolNames).toContain('get_system_status');
    expect(toolNames).not.toContain('server_start');
    expect(toolNames).not.toContain('server_stop');

    // init実行
    const initResult = await env.tester.callTool('init', {});
    expect(initResult.success).toBe(true);

    // 少し待機（状態更新のため）
    await new Promise((resolve) => setTimeout(resolve, 100));

    // tools/listを再取得
    response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
    toolNames = response.tools.map((t) => t.name);

    // init実行後: server_start, server_stop が追加される
    expect(toolNames).toContain('init');
    expect(toolNames).toContain('get_system_status');
    expect(toolNames).toContain('server_start');
    expect(toolNames).toContain('server_stop');

    // 検索系ツールはまだ利用不可
    expect(toolNames).not.toContain('search');
    expect(toolNames).not.toContain('get_document');
    expect(toolNames).not.toContain('index_status');
  });

  test(
    'server_start実行後に検索系ツールが利用可能になる',
    async () => {
      // CONFIGURED_SERVER_DOWN状態で起動
      env = await setupTestEnvironment({
        prefix: 'dynamic-start',
        createConfig: true,
        port: 54333,
        createIndexDir: false,
      });

      // 初期状態: 検索系ツールは利用不可
      let response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
      let toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toContain('server_start');
      expect(toolNames).not.toContain('search');
      expect(toolNames).not.toContain('get_document');
      expect(toolNames).not.toContain('index_status');

      // server_start実行
      const startResult = await env.tester.callTool('server_start', {});
      expect(startResult.success).toBe(true);

      // サーバ起動完了を待機
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // tools/listを再取得
      response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
      toolNames = response.tools.map((t) => t.name);

      // server_start実行後: 検索系ツールが追加される
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('get_document');
      expect(toolNames).toContain('index_status');
    },
    30000
  );

  test(
    'server_stop実行後に検索系ツールが利用不可になる',
    async () => {
      // RUNNING状態で起動（auto-start）
      env = await setupTestEnvironment({
        prefix: 'dynamic-stop',
        createConfig: true,
        port: 54332,
        createIndexDir: true,
      });

      // auto-start完了を待機
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 初期状態: 全ツール利用可能
      let response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
      let toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toContain('search');
      expect(toolNames).toContain('get_document');
      expect(toolNames).toContain('index_status');

      // server_stop実行
      const stopResult = await env.tester.callTool('server_stop', {});
      expect(stopResult.success).toBe(true);

      // サーバ停止完了を待機
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // tools/listを再取得
      response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
      toolNames = response.tools.map((t) => t.name);

      // server_stop実行後: 検索系ツールが削除される
      expect(toolNames).not.toContain('search');
      expect(toolNames).not.toContain('get_document');
      expect(toolNames).not.toContain('index_status');

      // サーバ制御ツールは残る
      expect(toolNames).toContain('server_start');
      expect(toolNames).toContain('server_stop');
    },
    40000
  );
});
