import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBEngine } from '../typescript/index.js';
import type { Section } from '@search-docs/types';
import * as fs from 'fs/promises';
import * as path from 'path';

const TEST_DB_PATH = './.search-docs-test/index';

describe('DBEngine', () => {
  let engine: DBEngine;

  beforeAll(async () => {
    // テスト用DBエンジンを作成
    engine = new DBEngine({
      dbPath: TEST_DB_PATH,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    });

    // 接続
    await engine.connect();

    // モデル初期化
    await engine.initModel();
  }, 120000); // 2分のタイムアウト（モデルダウンロード時間を考慮）

  afterAll(async () => {
    // 接続を切断
    await engine.disconnect();

    // テストDB削除
    try {
      await fs.rm(TEST_DB_PATH, { recursive: true, force: true });
    } catch (e) {
      // エラーは無視
    }
  });

  describe('接続', () => {
    it('pingが成功する', async () => {
      const status = await engine.ping();
      expect(status.status).toBe('ok');
    });

    it('ステータスを取得できる', async () => {
      const status = await engine.getStatus();
      expect(status.status).toBe('ok');
    });
  });

  describe('セクション操作', () => {
    const testSection: Omit<Section, 'vector'> = {
      id: 'test-section-1',
      documentPath: '/test/document.md',
      heading: 'テストセクション',
      depth: 1,
      content: 'これはテスト用のセクションです。',
      tokenCount: 10,
      parentId: null,
      order: 0,
      isDirty: false,
      documentHash: 'test-hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('セクションを追加できる', async () => {
      const result = await engine.addSection(testSection);
      expect(result.id).toBe(testSection.id);
    });

    it('パスでセクションを取得できる', async () => {
      const result = await engine.getSectionsByPath('/test/document.md');
      expect(result.sections).toBeDefined();
      expect(result.sections.length).toBeGreaterThan(0);
    });

    it('セクションを検索できる', async () => {
      const result = await engine.search({
        query: 'テスト',
        limit: 10,
      });
      expect(result.results).toBeDefined();
      expect(result.total).toBeGreaterThan(0);
    });

    it('depthでフィルタできる', async () => {
      const result = await engine.search({
        query: 'テスト',
        depth: 1,
        limit: 10,
      });
      expect(result.results).toBeDefined();
      for (const r of result.results) {
        expect(r.depth).toBe(1);
      }
    });

    it('統計情報を取得できる', async () => {
      const stats = await engine.getStats();
      expect(stats.totalSections).toBeGreaterThan(0);
      expect(stats.totalDocuments).toBeGreaterThan(0);
    });
  });

  describe('Dirty管理', () => {
    it('セクションをDirtyにマークできる', async () => {
      const result = await engine.markDirty('/test/document.md');
      expect(result.marked).toBe(true);
    });

    it('Dirtyなセクションを取得できる', async () => {
      const result = await engine.getDirtySections();
      expect(result.sections).toBeDefined();
      expect(result.sections.length).toBeGreaterThan(0);
    });

    it('統計情報にDirty数が反映される', async () => {
      const stats = await engine.getStats();
      expect(stats.dirtyCount).toBeGreaterThan(0);
    });
  });

  describe('複数セクション操作', () => {
    it('複数のセクションを一括追加できる', async () => {
      const sections: Array<Omit<Section, 'vector'>> = [
        {
          id: 'test-section-2',
          documentPath: '/test/document2.md',
          heading: 'セクション2',
          depth: 1,
          content: 'これは2番目のセクションです。',
          tokenCount: 10,
          parentId: null,
          order: 0,
          isDirty: false,
          documentHash: 'test-hash-2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'test-section-3',
          documentPath: '/test/document2.md',
          heading: 'セクション3',
          depth: 2,
          content: 'これは3番目のセクションです。',
          tokenCount: 10,
          parentId: 'test-section-2',
          order: 1,
          isDirty: false,
          documentHash: 'test-hash-2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const result = await engine.addSections(sections);
      expect(result.count).toBe(2);
    });
  });

  describe('削除操作', () => {
    it('パスでセクションを削除できる', async () => {
      const result = await engine.deleteSectionsByPath('/test/document2.md');
      expect(result.deleted).toBe(true);
    });

    it('削除後に取得できない', async () => {
      const result = await engine.getSectionsByPath('/test/document2.md');
      expect(result.sections.length).toBe(0);
    });
  });
});
