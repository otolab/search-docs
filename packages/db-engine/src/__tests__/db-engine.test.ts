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
      startLine: 1,
      endLine: 5,
      sectionNumber: [1],
    };

    it('セクションを追加できる', async () => {
      const result = await engine.addSections([testSection]);
      expect(result.count).toBe(1);
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
          startLine: 1,
          endLine: 10,
          sectionNumber: [1],
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
          startLine: 11,
          endLine: 15,
          sectionNumber: [1, 1],
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

  describe('IndexRequest操作', () => {
    const testDocPath = '/test/request-doc.md';
    const testHash = 'hash-v1';
    let requestId: string;

    it('IndexRequestを作成できる', async () => {
      const result = await engine.createIndexRequest({
        documentPath: testDocPath,
        documentHash: testHash,
      });
      expect(result.id).toBeDefined();
      expect(result.documentPath).toBe(testDocPath);
      expect(result.documentHash).toBe(testHash);
      expect(result.status).toBe('pending');
      expect(result.createdAt).toBeDefined();
      requestId = result.id;
    });

    it('IndexRequestを検索できる', async () => {
      const result = await engine.findIndexRequests({
        documentPath: testDocPath,
      });
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].documentPath).toBe(testDocPath);
    });

    it('statusでIndexRequestを検索できる', async () => {
      const result = await engine.findIndexRequests({
        status: 'pending',
      });
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      for (const req of result) {
        expect(req.status).toBe('pending');
      }
    });

    it('複数のstatusでIndexRequestを検索できる', async () => {
      const result = await engine.findIndexRequests({
        status: ['pending', 'processing'],
      });
      expect(result).toBeDefined();
      for (const req of result) {
        expect(['pending', 'processing']).toContain(req.status);
      }
    });

    it('created_at範囲でIndexRequestを検索できる', async () => {
      const now = new Date().toISOString();
      const result = await engine.findIndexRequests({
        createdAt: {
          $lt: now,
        },
      });
      expect(result).toBeDefined();
    });

    it('IndexRequestを更新できる', async () => {
      const result = await engine.updateIndexRequest(requestId, {
        status: 'processing',
        startedAt: new Date().toISOString(),
      });
      expect(result.id).toBe(requestId);
      expect(result.status).toBe('processing');
      expect(result.startedAt).toBeDefined();
    });

    it('複数のIndexRequestを一括更新できる', async () => {
      // まず別のリクエストを作成
      await engine.createIndexRequest({
        documentPath: '/test/request-doc2.md',
        documentHash: 'hash-v2',
      });
      await engine.createIndexRequest({
        documentPath: '/test/request-doc3.md',
        documentHash: 'hash-v3',
      });

      const result = await engine.updateManyIndexRequests(
        { status: 'pending' },
        { status: 'skipped' }
      );
      expect(result.updated).toBe(true);
      expect(result.count).toBeGreaterThan(0);

      // 更新を確認
      const updated = await engine.findIndexRequests({ status: 'skipped' });
      expect(updated.length).toBeGreaterThan(0);
    });

    it('特定のstatusを持つdocument_pathのリストを取得できる', async () => {
      const result = await engine.getPathsWithStatus(['processing', 'skipped']);
      expect(result).toBeDefined();
      expect(result).toContain(testDocPath);
    });
  });

  describe('Section拡張操作', () => {
    const testPath = '/test/hash-test.md';
    const hashV1 = 'hash-v1';
    const hashV2 = 'hash-v2';

    beforeAll(async () => {
      // v1ハッシュのセクションを追加
      await engine.addSections([{
        id: 'hash-test-section-1',
        documentPath: testPath,
        heading: 'Hash Test Section v1',
        depth: 1,
        content: 'This is version 1',
        tokenCount: 5,
        parentId: null,
        order: 0,
        isDirty: false,
        documentHash: hashV1,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 5,
        sectionNumber: [1],
      }]);

      // v2ハッシュのセクションを追加
      await engine.addSections([{
        id: 'hash-test-section-2',
        documentPath: testPath,
        heading: 'Hash Test Section v2',
        depth: 1,
        content: 'This is version 2',
        tokenCount: 5,
        parentId: null,
        order: 0,
        isDirty: false,
        documentHash: hashV2,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 6,
        endLine: 10,
        sectionNumber: [2],
      }]);
    });

    it('特定のパスとハッシュでセクションを検索できる', async () => {
      const result = await engine.findSectionsByPathAndHash(testPath, hashV1);
      expect(result.length).toBe(1);
      expect(result[0].documentHash).toBe(hashV1);
      expect(result[0].content).toBe('This is version 1');
    });

    it('指定ハッシュ以外のセクションを削除できる', async () => {
      const result = await engine.deleteSectionsByPathExceptHash(testPath, hashV2);
      expect(result.deleted).toBe(true);

      // v2のみ残っていることを確認
      const remaining = await engine.getSectionsByPath(testPath);
      expect(remaining.sections.length).toBe(1);
      expect(remaining.sections[0].documentHash).toBe(hashV2);
    });
  });
});
