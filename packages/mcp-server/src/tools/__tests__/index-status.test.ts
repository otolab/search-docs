/**
 * index_statusツールのテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerIndexStatusTool } from '../index-status.js';
import type { ToolRegistrationContext } from '../types.js';
import type { SystemStateInfo } from '../../state.js';
import { ServerManager } from '../../server-manager.js';

describe('index_status tool', () => {
  let mockServer: any;
  let mockServerManager: ServerManager;
  let registeredTool: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // MCPサーバのモック
    mockServer = {
      registerTool: vi.fn((name, schema, handler) => {
        registeredTool = { name, schema, handler };
      }),
    };

    // ServerManagerのモック
    mockServerManager = new ServerManager();
  });

  it('RUNNING状態の場合、正常に動作する', async () => {
    const mockResponse = {
      server: {
        version: '1.0.0',
        uptime: 123456,
        pid: 12345,
      },
      database: {
        connectionState: 'ready' as const,
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
      service: mockClient as any,
    };

    const context: ToolRegistrationContext = {
      server: mockServer,
      systemState,
      refreshSystemState: async () => {},
      serverManager: mockServerManager,
    };

    // ツール登録
    registerIndexStatusTool(context);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'index_status',
      expect.objectContaining({
        description: expect.stringContaining('インデックス'),
      }),
      expect.any(Function)
    );

    // ツールハンドラを実行
    const result = await registeredTool.handler({});

    expect(mockClient.getStatus).toHaveBeenCalled();
    expect(result.content[0].text).toContain('📊 インデックス状態');
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
      refreshSystemState: async () => {},
      serverManager: mockServerManager,
    };

    // ツール登録
    registerIndexStatusTool(context);

    // ツールハンドラを実行
    await expect(registeredTool.handler({})).rejects.toThrow('ローカルプロジェクトが設定されていない');
  });

  it('service.getStatus()がエラーの場合、エラーを返す', async () => {
    const mockClient = {
      getStatus: vi.fn().mockRejectedValue(new Error('Connection error')),
    };

    const systemState: SystemStateInfo = {
      state: 'RUNNING',
      config: {} as any,
      configPath: '/test/.search-docs.json',
      projectRoot: '/test',
      service: mockClient as any,
    };

    const context: ToolRegistrationContext = {
      server: mockServer,
      systemState,
      refreshSystemState: async () => {},
      serverManager: mockServerManager,
    };

    // ツール登録
    registerIndexStatusTool(context);

    // ツールハンドラを実行
    await expect(registeredTool.handler({})).rejects.toThrow('ステータス取得エラー');
  });
});
