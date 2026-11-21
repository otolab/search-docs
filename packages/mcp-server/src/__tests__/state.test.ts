/**
 * 状態管理のテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createService, detectSystemState, getStateErrorMessage, stopService } from '../state.js';
import type { SystemState, ServiceInstances } from '../state.js';
import { ConfigLoader } from '@search-docs/config';
import { MaintenanceLock, acquireStandardStorageRegistration } from '@search-docs/db-engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { EmbeddingServerProcess } from '@search-docs/server';

// モック
vi.mock('@search-docs/config');

describe('stopService', () => {
  it.skipIf(process.platform === 'win32')('起動前に共有登録を取得し、DB 利用前の起動失敗後に解放する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-registration-'));
    const lock = new MaintenanceLock(path.join(root, '.search-docs', '.search-docs-maintenance'));
    const start = vi.spyOn(EmbeddingServerProcess.prototype, 'start').mockImplementation(async () => {
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
      throw new Error('startup failed');
    });
    const shutdown = vi.spyOn(EmbeddingServerProcess.prototype, 'shutdown').mockImplementation(() => {});
    try {
      await expect(createService(DEFAULT_CONFIG, root, 'test')).rejects.toThrow('startup failed');
      const exclusive = await lock.acquireExclusive();
      await exclusive.release();
    } finally {
      start.mockRestore();
      shutdown.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('停止完了まで共有登録を保持する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-registration-'));
    try {
      const releaseStorageRegistration = await acquireStandardStorageRegistration({
        projectRoot: root, indexPath: '.search-docs/index', documentsPath: '.search-docs/documents',
      });
      const lock = new MaintenanceLock(path.join(root, '.search-docs', '.search-docs-maintenance'));
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const instances = {
        watcherProcess: { stop: vi.fn(() => gate) },
        service: { stop: vi.fn() },
        dbEngine: { disconnect: vi.fn() },
        embeddingServer: { shutdown: vi.fn() },
        releaseStorageRegistration,
      };
      const stopping = stopService(instances as unknown as ServiceInstances);
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
      finish();
      await stopping;
      const exclusive = await lock.acquireExclusive();
      await exclusive.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('停止失敗時は共有登録を残す', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-registration-'));
    try {
      const releaseStorageRegistration = await acquireStandardStorageRegistration({
        projectRoot: root, indexPath: '.search-docs/index', documentsPath: '.search-docs/documents',
      });
      const lock = new MaintenanceLock(path.join(root, '.search-docs', '.search-docs-maintenance'));
      const instances = {
        watcherProcess: { stop: vi.fn().mockRejectedValue(new Error('stop failed')) },
        service: { stop: vi.fn() },
        dbEngine: { disconnect: vi.fn() },
        embeddingServer: { shutdown: vi.fn() },
        releaseStorageRegistration,
      };
      await expect(stopService(instances as unknown as ServiceInstances)).rejects.toThrow('stop failed');
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for writer drain before stopping dependencies', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const instances = {
      watcherProcess: { stop: vi.fn(() => gate) },
      service: { stop: vi.fn() },
      dbEngine: { disconnect: vi.fn() },
      embeddingServer: { shutdown: vi.fn() },
    };
    const stopped = stopService(instances as unknown as ServiceInstances);
    expect(instances.dbEngine.disconnect).not.toHaveBeenCalled();
    release();
    await stopped;
    expect(instances.service.stop).toHaveBeenCalledOnce();
    expect(instances.dbEngine.disconnect).toHaveBeenCalledOnce();
    expect(instances.embeddingServer.shutdown).toHaveBeenCalledOnce();
  });

  it('cleans up dependencies when writer stop fails', async () => {
    const instances = {
      watcherProcess: { stop: vi.fn().mockRejectedValue(new Error('stop failed')) },
      service: { stop: vi.fn() },
      dbEngine: { disconnect: vi.fn() },
      embeddingServer: { shutdown: vi.fn() },
    };
    await expect(stopService(instances as unknown as ServiceInstances)).rejects.toThrow('stop failed');
    expect(instances.dbEngine.disconnect).toHaveBeenCalledOnce();
    expect(instances.embeddingServer.shutdown).toHaveBeenCalledOnce();
  });
});

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
        deprecations: [],
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
        deprecations: [],
      });

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('RUNNING');
      expect(result.config).toBe(mockConfig);
      expect(result.configPath).toBe('/test/project/.search-docs.json');
      expect(result.projectRoot).toBe('/test/project');
      expect(result.service).toBeUndefined();
    });

    it('非推奨フィールドがある場合、deprecationsを返す', async () => {
      const mockConfig = {
        version: '1.0',
        server: { host: 'localhost', port: 24280, protocol: 'json-rpc' as const },
      } as any;
      const mockDeprecations = [{
        field: 'files.include',
        message: 'files.include は非推奨です。files.sources に変更してください。',
        migration: '設定ファイルの "files"."include" を "files"."sources" にリネームしてください。',
      }];

      vi.mocked(ConfigLoader.resolve).mockResolvedValue({
        config: mockConfig,
        configPath: '/test/project/.search-docs.json',
        projectRoot: '/test/project',
        deprecations: mockDeprecations,
      });

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('RUNNING');
      expect(result.deprecations).toEqual(mockDeprecations);
    });

    it('非推奨フィールドがない場合、deprecationsはundefined', async () => {
      const mockConfig = {
        version: '1.0',
        server: { host: 'localhost', port: 24280, protocol: 'json-rpc' as const },
      } as any;

      vi.mocked(ConfigLoader.resolve).mockResolvedValue({
        config: mockConfig,
        configPath: '/test/project/.search-docs.json',
        projectRoot: '/test/project',
        deprecations: [],
      });

      const result = await detectSystemState('/test/project');

      expect(result.state).toBe('RUNNING');
      expect(result.deprecations).toBeUndefined();
    });
  });

  describe('getStateErrorMessage', () => {
    it('NOT_CONFIGURED状態のエラーメッセージを返す', () => {
      const message = getStateErrorMessage('NOT_CONFIGURED', '検索');

      expect(message).toContain('検索を実行できません');
      expect(message).toContain('ローカルプロジェクトが設定されていない');
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
