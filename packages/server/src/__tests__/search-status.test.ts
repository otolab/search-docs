/**
 * Phase 5: 検索ロジック更新のテスト
 * - indexStatusフィルタのテスト
 * - 状態計算のテスト（latest, updating, outdated）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SearchDocsServer } from '../server/search-docs-server.js';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsConfig, Document } from '@search-docs/types';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 5: 検索時のindexStatus機能', () => {
  let server: SearchDocsServer;
  let storage: FileStorage;
  let dbEngine: DBEngine;
  const testDir = path.join(__dirname, 'test-search-status');
  const dbPath = path.join(testDir, 'db');
  const storagePath = path.join(testDir, 'storage');

  const config: SearchDocsConfig = {
    version: '1.0',
    project: {
      name: 'test-project',
      root: testDir,
    },
    files: {
      include: ['**/*.md'],
      exclude: [],
      ignoreGitignore: false,
    },
    indexing: {
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    },
    search: {
      defaultLimit: 10,
      maxLimit: 100,
      includeCleanOnly: false,
    },
    server: {
      host: 'localhost',
      port: 24280,
      protocol: 'json-rpc',
    },
    storage: {
      documentsPath: storagePath,
      indexPath: dbPath,
      cachePath: path.join(testDir, 'cache'),
    },
    worker: {
      enabled: false, // テストではWorkerを無効化
      interval: 5000,
      maxConcurrent: 3,
    },
    watcher: {
      enabled: false, // テストではWatcherを無効化
      debounceMs: 1000,
      awaitWriteFinishMs: 100,
    },
  };

  beforeAll(async () => {
    // テストディレクトリを作成
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(dbPath, { recursive: true });
    await fs.mkdir(storagePath, { recursive: true });

    // DBEngineとStorageを初期化
    dbEngine = new DBEngine({ dbPath });
    await dbEngine.connect();

    storage = new FileStorage({ basePath: storagePath });

    // Serverを初期化
    server = new SearchDocsServer(config, storage, dbEngine);
    await server.start();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (dbEngine) {
      dbEngine.disconnect();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 各テスト前にデータをクリア（テストの独立性を確保）
    // Note: 現状、包括的なクリアAPIがないため、各テストで異なるドキュメント名を使用する
  });

  describe('状態計算のテスト', () => {
    it('indexStatus: latest_only - pending/processingのあるパスを除外する', async () => {
      // 1. 文書を2つ作成
      const doc1: Document = {
        path: 'doc1.md',
        content: 'This is document one with some content.',
        metadata: {
          fileHash: createHash('sha256').update('doc1-v1').digest('hex'),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      const doc2: Document = {
        path: 'doc2.md',
        content: 'This is document two with some content.',
        metadata: {
          fileHash: createHash('sha256').update('doc2-v1').digest('hex'),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(doc1.path, doc1);
      await storage.save(doc2.path, doc2);

      // 2. doc1とdoc2のセクションを作成（完成状態）
      await dbEngine.addSections([{
        id: 'section-1',
        documentPath: doc1.path,
        documentHash: doc1.metadata.fileHash,
        heading: 'Section 1',
        depth: 1,
        content: doc1.content,
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      }]);

      await dbEngine.addSections([{
        id: 'section-2',
        documentPath: doc2.path,
        documentHash: doc2.metadata.fileHash,
        heading: 'Section 2',
        depth: 1,
        content: doc2.content,
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      }]);

      // 3. doc1にpendingリクエストを作成（更新中状態）
      await dbEngine.createIndexRequest({
        documentPath: doc1.path,
        documentHash: createHash('sha256').update('doc1-v2').digest('hex'),
      });

      // 4. indexStatus: latest_onlyで検索
      const results = await server.search({
        query: 'document content',
        options: {
          indexStatus: 'latest_only',
          limit: 10,
        },
      });

      // 5. doc2のみが返される（doc1は除外される）
      expect(results.results.length).toBe(1);
      expect(results.results[0].documentPath).toBe('doc2.md');
    });

    it('indexStatus: all - すべてのパスを返す', async () => {
      // 新しい文書を作成（独立したテスト）
      const doc3: Document = {
        path: 'doc3-all.md',
        content: 'This is document three for all test.',
        metadata: {
          fileHash: createHash('sha256').update('doc3-v1').digest('hex'),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(doc3.path, doc3);

      await dbEngine.addSections([{
        id: 'section-3-all',
        documentPath: doc3.path,
        documentHash: doc3.metadata.fileHash,
        heading: 'Section 3',
        depth: 1,
        content: doc3.content,
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      }]);

      // indexStatus未指定またはallの場合、すべて返す
      const results = await server.search({
        query: 'document three all test',
        options: {
          indexStatus: 'all',
          limit: 10,
        },
      });

      // doc3が返される
      expect(results.results.length).toBeGreaterThanOrEqual(1);
      const result = results.results.find((r) => r.documentPath === 'doc3-all.md');
      expect(result).toBeDefined();
    });
  });

  describe('indexStatusフィルタのテスト (フィルタ機能)', () => {
    it('latest状態 - ハッシュが一致し、pendingリクエストがない', async () => {
      const content = 'This is a unique latest document with special keyword xyzlatest.';
      const contentHash = createHash('sha256').update(content).digest('hex');

      const doc: Document = {
        path: 'latest-doc.md',
        content,
        metadata: {
          fileHash: contentHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(doc.path, doc);

      // storage.save() recalculates hash, so retrieve the saved document
      const saved = await storage.get(doc.path);

      await dbEngine.addSections([{
        id: 'latest-section',
        documentPath: doc.path,
        documentHash: saved!.metadata.fileHash,
        heading: 'Latest Section',
        depth: 1,
        content: doc.content,
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      }]);

      const results = await server.search({
        query: 'unique latest document xyzlatest',
        options: { limit: 10 },
      });

      const result = results.results.find((r) => r.documentPath === 'latest-doc.md');
      expect(result).toBeDefined();

      // デバッグ情報を出力
      console.log('Test: latest-doc.md');
      console.log('  Expected hash:', doc.metadata.fileHash);
      console.log('  Section hash:', result!.documentHash);
      console.log('  Index status:', result!.indexStatus);
      console.log('  Is latest:', result!.isLatest);
      console.log('  Has pending:', result!.hasPendingUpdate);

      expect(result!.indexStatus).toBe('latest');
      expect(result!.isLatest).toBe(true);
      expect(result!.hasPendingUpdate).toBe(false);
    });

    it('updating状態 - pendingリクエストがある', async () => {
      const doc: Document = {
        path: 'updating-doc.md',
        content: 'This document is being updated.',
        metadata: {
          fileHash: createHash('sha256').update('updating-v2').digest('hex'),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(doc.path, doc);

      // 古いバージョンのセクション
      await dbEngine.addSections([{
        id: 'updating-section',
        documentPath: doc.path,
        documentHash: createHash('sha256').update('updating-v1').digest('hex'),
        heading: 'Updating Section',
        depth: 1,
        content: 'Old content',
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      }]);

      // pendingリクエストを作成
      await dbEngine.createIndexRequest({
        documentPath: doc.path,
        documentHash: doc.metadata.fileHash,
      });

      const results = await server.search({
        query: 'updating',
        options: { limit: 10 },
      });

      const result = results.results.find((r) => r.documentPath === 'updating-doc.md');
      expect(result).toBeDefined();
      expect(result!.indexStatus).toBe('updating');
      expect(result!.hasPendingUpdate).toBe(true);
    });

    it('outdated状態 - ハッシュが一致せず、pendingリクエストもない', async () => {
      const doc: Document = {
        path: 'outdated-doc.md',
        content: 'This document is outdated.',
        metadata: {
          fileHash: createHash('sha256').update('outdated-v2').digest('hex'),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(doc.path, doc);

      // 古いバージョンのセクション
      await dbEngine.addSections([{
        id: 'outdated-section',
        documentPath: doc.path,
        documentHash: createHash('sha256').update('outdated-v1').digest('hex'),
        heading: 'Outdated Section',
        depth: 1,
        content: 'Old content',
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      }]);

      // pendingリクエストは作成しない

      const results = await server.search({
        query: 'outdated',
        options: { limit: 10 },
      });

      const result = results.results.find((r) => r.documentPath === 'outdated-doc.md');
      expect(result).toBeDefined();
      expect(result!.indexStatus).toBe('outdated');
      expect(result!.isLatest).toBe(false);
      expect(result!.hasPendingUpdate).toBe(false);
    });
  });
});
