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

    // init実行後: 全ツールが利用可能になる
    expect(toolNames).toContain('init');
    expect(toolNames).toContain('get_system_status');
    expect(toolNames).toContain('server_start');
    expect(toolNames).toContain('server_stop');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('get_document');
    expect(toolNames).toContain('index_status');
  });

  test('CONFIGURED状態では全ツールが利用可能', async () => {
    // CONFIGURED_SERVER_DOWN状態で起動
    env = await setupTestEnvironment({
      prefix: 'dynamic-configured',
      createConfig: true,
      port: 54333,
      createIndexDir: false,
    });

    // 初期状態: 設定済みなので全ツール利用可能
    let response = (await env.tester.sendRequest('tools/list', {})) as MCPToolsListResponse;
    let toolNames = response.tools.map((t) => t.name);

    // 全ツールが利用可能
    expect(toolNames).toContain('init');
    expect(toolNames).toContain('server_start');
    expect(toolNames).toContain('server_stop');
    expect(toolNames).toContain('get_system_status');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('get_document');
    expect(toolNames).toContain('index_status');
  });
});
