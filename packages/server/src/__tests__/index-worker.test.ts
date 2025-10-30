/**
 * IndexWorkerのユニットテスト
 *
 * このテストはモックDBEngineを使用してPython依存を排除しています。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DBEngine, IndexRequest } from '@search-docs/db-engine';
import type { DocumentStorage, Section } from '@search-docs/types';
import { IndexWorker } from '../worker/index-worker.js';
import { MarkdownSplitter } from '../splitter/markdown-splitter.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// モックDBEngineクラス
class MockDBEngine {
  private requests: Map<string, IndexRequest> = new Map();
  private sections: Section[] = [];

  async connect(): Promise<void> {}
  disconnect(): void {}

  async createIndexRequest(params: { documentPath: string; documentHash: string }): Promise<IndexRequest> {
    const request: IndexRequest = {
      id: `req-${Date.now()}-${Math.random()}`,
      documentPath: params.documentPath,
      documentHash: params.documentHash,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  async findIndexRequests(filter: any): Promise<IndexRequest[]> {
    let results = Array.from(this.requests.values());

    if (filter.documentPath) {
      results = results.filter((r) => r.documentPath === filter.documentPath);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter((r) => statuses.includes(r.status));
    }
    if (filter.createdAt?.$lt) {
      results = results.filter((r) => r.createdAt < filter.createdAt.$lt);
    }

    if (filter.order === 'created_at ASC') {
      results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    return results;
  }

  async updateIndexRequest(id: string, updates: Partial<IndexRequest>): Promise<IndexRequest> {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`IndexRequest not found: ${id}`);
    }
    Object.assign(request, updates);
    return request;
  }

  async updateManyIndexRequests(filter: any, updates: Partial<IndexRequest>): Promise<number> {
    const matching = await this.findIndexRequests(filter);
    for (const request of matching) {
      Object.assign(request, updates);
    }
    return matching.length;
  }

  async findSectionsByPathAndHash(documentPath: string, documentHash: string): Promise<Section[]> {
    return this.sections.filter(
      (s) => s.documentPath === documentPath && s.documentHash === documentHash
    );
  }

  async deleteSectionsByPathExceptHash(documentPath: string, documentHash: string): Promise<number> {
    const toDelete = this.sections.filter(
      (s) => s.documentPath === documentPath && s.documentHash !== documentHash
    );
    this.sections = this.sections.filter(
      (s) => s.documentPath !== documentPath || s.documentHash === documentHash
    );
    return toDelete.length;
  }

  async addSection(section: Omit<Section, 'vector'>): Promise<void> {
    // vectorフィールドを追加してSectionに変換
    const fullSection: Section = {
      ...section,
      vector: new Float32Array(256),
    };
    this.sections.push(fullSection);
  }
}

describe('IndexWorker', () => {
  let dbEngine: DBEngine;
  let storage: DocumentStorage;
  let splitter: MarkdownSplitter;
  let worker: IndexWorker;
  const testDbPath = path.join(__dirname, 'test-db-worker');
  const testStoragePath = path.join(__dirname, 'test-storage-worker');

  beforeEach(async () => {
    // テスト用DBとストレージの準備
    await fs.mkdir(testDbPath, { recursive: true });
    await fs.mkdir(testStoragePath, { recursive: true });

    // MockDBEngineを使用（Python依存を排除）
    dbEngine = new MockDBEngine() as unknown as DBEngine;
    await dbEngine.connect();

    // シンプルなモックストレージ
    const documents = new Map();
    storage = {
      save: async (path: string, doc: any) => {
        documents.set(path, doc);
      },
      get: async (path: string) => {
        return documents.get(path) || null;
      },
      delete: async (path: string) => {
        documents.delete(path);
      },
      list: async () => Array.from(documents.keys()),
      exists: async (path: string) => documents.has(path),
    };

    splitter = new MarkdownSplitter({
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    });

    worker = new IndexWorker({
      dbEngine,
      storage,
      splitter,
      interval: 1000, // テスト用に短く
      maxConcurrent: 3,
    });
  });

  afterEach(async () => {
    if (worker) {
      worker.stop();
    }
    if (dbEngine) {
      dbEngine.disconnect();
    }
    await fs.rm(testDbPath, { recursive: true, force: true });
    await fs.rm(testStoragePath, { recursive: true, force: true });
  });

  describe('起動・停止', () => {
    it('ワーカーを起動できる', () => {
      worker.start();
      const status = worker.getStatus();
      expect(status.running).toBe(true);
    });

    it('ワーカーを停止できる', () => {
      worker.start();
      worker.stop();
      const status = worker.getStatus();
      expect(status.running).toBe(false);
    });

    it('二重起動は無視される', () => {
      worker.start();
      worker.start(); // 2回目
      const status = worker.getStatus();
      expect(status.running).toBe(true);
    });
  });

  describe('IndexRequest処理', () => {
    const testPath = 'test-doc.md';
    const testContent = `# Test Document

This is a test document.

## Section 1

Content of section 1.

## Section 2

Content of section 2.
`;
    const testHash = 'test-hash-123';

    beforeEach(async () => {
      // ストレージに文書を保存
      await storage.save(testPath, {
        path: testPath,
        content: testContent,
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          fileHash: testHash,
        },
      });
    });

    it('pendingリクエストを処理してセクションを作成する', async () => {
      // IndexRequestを作成
      const request = await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: testHash,
      });

      expect(request.status).toBe('pending');

      // 手動で処理を実行
      await worker.processNextRequests();

      // リクエストがcompletedになっているか確認
      const requests = await dbEngine.findIndexRequests({
        documentPath: testPath,
      });

      expect(requests.length).toBe(1);
      expect(requests[0].status).toBe('completed');
      expect(requests[0].completedAt).toBeDefined();

      // セクションが作成されているか確認
      const sections = await dbEngine.findSectionsByPathAndHash(testPath, testHash);
      expect(sections.length).toBeGreaterThan(0);
    });

    it('同じdocument_pathの最新リクエストのみ処理する', async () => {
      const hash1 = 'hash-v1';
      const hash2 = 'hash-v2';
      const hash3 = 'hash-v3';

      // 3つのリクエストを作成
      const req1 = await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: hash1,
      });
      await new Promise((resolve) => setTimeout(resolve, 10)); // 時間差

      const req2 = await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: hash2,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const req3 = await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: hash3,
      });

      // 最新のハッシュで文書を更新
      await storage.save(testPath, {
        path: testPath,
        content: testContent + '\n## Section 3\nNew content.',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          fileHash: hash3,
        },
      });

      // 処理実行
      await worker.processNextRequests();

      // リクエストの状態を確認
      const allRequests = await dbEngine.findIndexRequests({
        documentPath: testPath,
      });

      // hash3 (最新) のみがcompleted、古いものはskipped
      const req1Updated = allRequests.find((r) => r.id === req1.id);
      const req2Updated = allRequests.find((r) => r.id === req2.id);
      const req3Updated = allRequests.find((r) => r.id === req3.id);

      expect(req1Updated?.status).toBe('skipped');
      expect(req2Updated?.status).toBe('skipped');
      expect(req3Updated?.status).toBe('completed');
    });

    it('処理中にハッシュが変わった場合は完了扱い', async () => {
      const oldHash = 'old-hash';

      // 古いハッシュでリクエスト作成
      const request = await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: oldHash,
      });

      // ストレージには新しいハッシュの文書が保存されている（既に更新済み）
      // testHashが使われているので、oldHashと一致しない

      // 処理実行
      await worker.processNextRequests();

      // リクエストはcompletedになるが、セクションは作成されない
      const requests = await dbEngine.findIndexRequests({
        documentPath: testPath,
      });

      expect(requests[0].status).toBe('completed');

      // 古いハッシュのセクションは作成されない
      const sections = await dbEngine.findSectionsByPathAndHash(testPath, oldHash);
      expect(sections.length).toBe(0);
    });

    it('文書が見つからない場合はfailedになる', async () => {
      const missingPath = 'missing.md';

      // 存在しない文書のリクエストを作成
      const request = await dbEngine.createIndexRequest({
        documentPath: missingPath,
        documentHash: 'some-hash',
      });

      // 処理実行
      await worker.processNextRequests();

      // failedになっているか確認
      const requests = await dbEngine.findIndexRequests({
        documentPath: missingPath,
      });

      expect(requests[0].status).toBe('failed');
      expect(requests[0].error).toContain('Document not found');
    });

    it('既存のindexがある場合は古いものを削除', async () => {
      const oldHash = 'hash-v1';
      const newHash = 'hash-v2';

      // 古いindexを作成
      const oldSection: Section = {
        id: 'old-section-1',
        documentPath: testPath,
        heading: 'Old Heading',
        depth: 1,
        content: 'Old content',
        tokenCount: 100,
        vector: new Float32Array(256),
        parentId: null,
        order: 0,
        isDirty: false,
        documentHash: oldHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await dbEngine.addSection(oldSection);

      // 新しいハッシュで文書を更新
      await storage.save(testPath, {
        path: testPath,
        content: testContent,
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          fileHash: newHash,
        },
      });

      // 新しいindexリクエスト
      await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: newHash,
      });

      // 処理実行
      await worker.processNextRequests();

      // 新しいindexのみ存在するか確認
      const oldSections = await dbEngine.findSectionsByPathAndHash(testPath, oldHash);
      const newSections = await dbEngine.findSectionsByPathAndHash(testPath, newHash);

      expect(oldSections.length).toBe(0);
      expect(newSections.length).toBeGreaterThan(0);
    });
  });

  describe('バックグラウンド処理', () => {
    it('定期的に処理が実行される', async () => {
      const testPath = 'auto-test.md';
      const testHash = 'auto-hash';

      await storage.save(testPath, {
        path: testPath,
        content: '# Auto Test\n\nContent.',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          fileHash: testHash,
        },
      });

      await dbEngine.createIndexRequest({
        documentPath: testPath,
        documentHash: testHash,
      });

      // ワーカー起動
      worker.start();

      // 一定時間待機（interval=1000ms）
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 処理されているか確認
      const requests = await dbEngine.findIndexRequests({
        documentPath: testPath,
      });

      expect(requests[0].status).toBe('completed');
      worker.stop();
    });
  });
});
