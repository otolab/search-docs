/**
 * index_statusツールのテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerIndexStatusTool } from '../index-status.js';
import type { ToolRegistrationContext } from '../types.js';
import type { SystemStateInfo } from '../../state.js';

describe('index_status tool', () => {
  let mockServer: any;
  let registeredTool: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // MCPサーバのモック
    mockServer = {
      registerTool: vi.fn((name, schema, handler) => {
        registeredTool = { name, schema, handler };
      }),
    };
  });

  it('RUNNING状態の場合、正常に動作する', async () => {
    const mockResponse = {
      server: {
        version: '1.0.0',
        uptime: 123456,
        pid: 12345,
      },
      index: {
        totalDocuments: 10,
        totalSections: 50,
        dirtyCount: 2,
      },
      worker: {
        running: true,
        processing: 1,
        queue: 3,
      },
    };

    const mockClient = {
      getStatus: vi.fn().mockResolvedValue(mockResponse),
    };

    const systemState: SystemStateInfo = {
      state: 'RUNNING',
      config: {} as any,
      configPath: '/test/.search-docs.json',
      projectRoot: '/test',
      serverUrl: 'http://localhost:24280',
      client: mockClient as any,
    };

    const context: ToolRegistrationContext = {
      server: mockServer,
      systemState,
    };

    // ツール登録
    registerIndexStatusTool(context);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'index_status',
      expect.objectContaining({
        description: expect.stringContaining('インデックスの状態'),
      }),
      expect.any(Function)
    );

    // ツールハンドラを実行
    const result = await registeredTool.handler();

    expect(mockClient.getStatus).toHaveBeenCalled();
    expect(result.content[0].text).toContain('📊 インデックス状態');
    expect(result.content[0].text).toContain('バージョン: 1.0.0');
    expect(result.content[0].text).toContain('総文書数: 10件');
    expect(result.content[0].text).toContain('総セクション数: 50件');
    expect(result.content[0].text).toContain('Dirtyセクション: 2件');
    expect(result.content[0].text).toContain('実行中: Yes');
  });

  it('NOT_CONFIGURED状態の場合、エラーを返す', async () => {
    const systemState: SystemStateInfo = {
      state: 'NOT_CONFIGURED',
      projectRoot: '/test',
    };

    const context: ToolRegistrationContext = {
      server: mockServer,
      systemState,
    };

    // ツール登録
    registerIndexStatusTool(context);

    // ツールハンドラを実行
    await expect(registeredTool.handler()).rejects.toThrow('セットアップされていません');
  });

  it('CONFIGURED_SERVER_DOWN状態の場合、エラーを返す', async () => {
    const systemState: SystemStateInfo = {
      state: 'CONFIGURED_SERVER_DOWN',
      config: {} as any,
      configPath: '/test/.search-docs.json',
      projectRoot: '/test',
      serverUrl: 'http://localhost:24280',
    };

    const context: ToolRegistrationContext = {
      server: mockServer,
      systemState,
    };

    // ツール登録
    registerIndexStatusTool(context);

    // ツールハンドラを実行
    await expect(registeredTool.handler()).rejects.toThrow('起動していません');
  });

  it('client.getStatus()がエラーの場合、エラーを返す', async () => {
    const mockClient = {
      getStatus: vi.fn().mockRejectedValue(new Error('Connection error')),
    };

    const systemState: SystemStateInfo = {
      state: 'RUNNING',
      config: {} as any,
      configPath: '/test/.search-docs.json',
      projectRoot: '/test',
      serverUrl: 'http://localhost:24280',
      client: mockClient as any,
    };

    const context: ToolRegistrationContext = {
      server: mockServer,
      systemState,
    };

    // ツール登録
    registerIndexStatusTool(context);

    // ツールハンドラを実行
    await expect(registeredTool.handler()).rejects.toThrow('ステータス取得エラー');
  });
});
