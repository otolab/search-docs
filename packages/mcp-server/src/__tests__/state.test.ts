/**
 * 状態管理のテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectSystemState, getStateErrorMessage } from '../state.js';
import type { SystemState } from '../state.js';
import { ConfigLoader } from '@search-docs/types';
import { SearchDocsClient } from '@search-docs/client';

// モック
vi.mock('@search-docs/types');
vi.mock('@search-docs/client');

describe('state', () => {
  describe('detectSystemState', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('設定ファイルがない場合、NOT_CONFIGUREDを返す', async () => {
      // ConfigLoader.resolve が設定なしを返す
      vi.mocked(ConfigLoader.resolve).mockResolvedValue({
        config: undefined,
        configPath: undefined,
        projectRoot: '/test/project',
      });

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('NOT_CONFIGURED');
      expect(result.projectRoot).toBe('/test/project');
      expect(result.config).toBeUndefined();
      expect(result.configPath).toBeUndefined();
    });

    it('設定ファイル読み込みエラーの場合、NOT_CONFIGUREDを返す', async () => {
      // ConfigLoader.resolve がエラーを投げる
      vi.mocked(ConfigLoader.resolve).mockRejectedValue(
        new Error('Configuration file not found')
      );

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('NOT_CONFIGURED');
      expect(result.projectRoot).toBe('/test/project');
    });

    it('設定ファイルがあるがサーバが停止中の場合、CONFIGURED_SERVER_DOWNを返す', async () => {
      const mockConfig = {
        version: '1.0',
        server: {
          host: 'localhost',
          port: 24280,
          protocol: 'json-rpc' as const,
        },
      } as any;

      // ConfigLoader.resolve が設定を返す
      vi.mocked(ConfigLoader.resolve).mockResolvedValue({
        config: mockConfig,
        configPath: '/test/project/.search-docs.json',
        projectRoot: '/test/project',
      });

      // SearchDocsClient.healthCheck がエラーを投げる（サーバ停止中）
      const mockHealthCheck = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.mocked(SearchDocsClient).mockImplementation(
        class {
          healthCheck = mockHealthCheck;
        } as any
      );

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('CONFIGURED_SERVER_DOWN');
      expect(result.config).toBe(mockConfig);
      expect(result.configPath).toBe('/test/project/.search-docs.json');
      expect(result.projectRoot).toBe('/test/project');
      expect(result.serverUrl).toBe('http://localhost:24280');
      expect(result.client).toBeUndefined();
    });

    it('設定ファイルがありサーバが稼働中の場合、RUNNINGを返す', async () => {
      const mockConfig = {
        version: '1.0',
        server: {
          host: 'localhost',
          port: 24280,
          protocol: 'json-rpc' as const,
        },
      } as any;

      // ConfigLoader.resolve が設定を返す
      vi.mocked(ConfigLoader.resolve).mockResolvedValue({
        config: mockConfig,
        configPath: '/test/project/.search-docs.json',
        projectRoot: '/test/project',
      });

      // SearchDocsClient.healthCheck が成功（サーバ稼働中）
      const mockHealthCheck = vi.fn().mockResolvedValue(undefined);
      vi.mocked(SearchDocsClient).mockImplementation(
        class {
          healthCheck = mockHealthCheck;
        } as any
      );

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('RUNNING');
      expect(result.config).toBe(mockConfig);
      expect(result.configPath).toBe('/test/project/.search-docs.json');
      expect(result.projectRoot).toBe('/test/project');
      expect(result.serverUrl).toBe('http://localhost:24280');
      expect(result.client).toBeDefined();
    });
  });

  describe('getStateErrorMessage', () => {
    it('NOT_CONFIGURED状態のエラーメッセージを返す', () => {
      const message = getStateErrorMessage('NOT_CONFIGURED', '検索');

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('セットアップされていません');
      expect(message).toContain('init');
      expect(message).toContain('server_start');
    });

    it('CONFIGURED_SERVER_DOWN状態のエラーメッセージを返す', () => {
      const message = getStateErrorMessage('CONFIGURED_SERVER_DOWN', '検索');

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('起動していません');
      expect(message).toContain('server_start');
    });

    it('RUNNING状態のエラーメッセージを返す', () => {
      const message = getStateErrorMessage('RUNNING', '検索');

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('予期しないエラー');
    });
  });
});
