/**
 * 状態管理のテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectSystemState, getStateErrorMessage } from '../state.js';
import type { SystemState } from '../state.js';
import { ConfigLoader } from '@search-docs/types';

// モック
vi.mock('@search-docs/types');

describe('state', () => {
  describe('detectSystemState', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('設定ファイルがない場合、NOT_CONFIGUREDを返す', async () => {
      // ConfigLoader.resolve が設定なしを返す
      vi.mocked(ConfigLoader.resolve).mockResolvedValue({
        config: null as any,
        configPath: null,
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

    it('設定ファイルがある場合、RUNNINGを返す', async () => {
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

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('RUNNING');
      expect(result.config).toBe(mockConfig);
      expect(result.configPath).toBe('/test/project/.search-docs.json');
      expect(result.projectRoot).toBe('/test/project');
      expect(result.service).toBeUndefined();
    });
  });

  describe('getStateErrorMessage', () => {
    it('NOT_CONFIGURED状態のエラーメッセージを返す', () => {
      const message = getStateErrorMessage('NOT_CONFIGURED', '検索');

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('セットアップされていません');
      expect(message).toContain('init');
      expect(message).toContain('add_related_project');
    });

    it('RUNNING状態のエラーメッセージを返す', () => {
      const message = getStateErrorMessage('RUNNING', '検索');

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('予期しないエラー');
    });

    it('NOT_CONFIGURED状態で関連プロジェクト名を表示する', () => {
      const message = getStateErrorMessage('NOT_CONFIGURED', '検索', ['project-a', 'project-b']);

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('add_related_project');
      expect(message).toContain('project-a, project-b');
    });

    it('NOT_CONFIGURED状態で関連プロジェクトが空の場合はプロジェクト名を表示しない', () => {
      const message = getStateErrorMessage('NOT_CONFIGURED', '検索', []);

      expect(message).toContain('検索を実行できません');
      expect(message).not.toContain('利用可能な関連プロジェクト');
    });
  });
});
