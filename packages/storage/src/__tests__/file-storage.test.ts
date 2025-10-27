/**
 * FileStorageのテスト
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStorage } from '../file-storage.js';
import type { Document } from '@search-docs/types';

describe('FileStorage', () => {
  let storage: FileStorage;
  let testDir: string;

  beforeEach(async () => {
    // テスト用の一時ディレクトリを作成
    testDir = join(tmpdir(), `search-docs-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    storage = new FileStorage({ basePath: testDir });
  });

  afterEach(async () => {
    // テスト用ディレクトリを削除
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('save', () => {
    it('文書を保存できる', async () => {
      const document: Document = {
        path: 'test/document.md',
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);

      // ファイルが存在することを確認
      const exists = await storage.exists(document.path);
      expect(exists).toBe(true);
    });

    it('文書にハッシュが追加される', async () => {
      const document: Document = {
        path: 'test/document.md',
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);
      const saved = await storage.get(document.path);

      expect(saved?.metadata.fileHash).toBeDefined();
      expect(typeof saved?.metadata.fileHash).toBe('string');
    });

    it('ネストされたパスで保存できる', async () => {
      const document: Document = {
        path: 'a/b/c/document.md',
        title: 'ネストされた文書',
        content: '深い階層の文書',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);

      const exists = await storage.exists(document.path);
      expect(exists).toBe(true);
    });
  });

  describe('get', () => {
    it('保存した文書を取得できる', async () => {
      const document: Document = {
        path: 'test/document.md',
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);
      const retrieved = await storage.get(document.path);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.path).toBe(document.path);
      expect(retrieved?.title).toBe(document.title);
      expect(retrieved?.content).toBe(document.content);
    });

    it('存在しない文書はnullを返す', async () => {
      const retrieved = await storage.get('non-existent.md');
      expect(retrieved).toBeNull();
    });

    it('取得した文書のメタデータがDate型である', async () => {
      const document: Document = {
        path: 'test/document.md',
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);
      const retrieved = await storage.get(document.path);

      expect(retrieved?.metadata.createdAt).toBeInstanceOf(Date);
      expect(retrieved?.metadata.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('delete', () => {
    it('文書を削除できる', async () => {
      const document: Document = {
        path: 'test/document.md',
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);
      await storage.delete(document.path);

      const exists = await storage.exists(document.path);
      expect(exists).toBe(false);
    });

    it('存在しない文書の削除でエラーにならない', async () => {
      await expect(storage.delete('non-existent.md')).resolves.not.toThrow();
    });
  });

  describe('list', () => {
    it('すべての文書パスを取得できる', async () => {
      const documents: Document[] = [
        {
          path: 'doc1.md',
          title: '文書1',
          content: '内容1',
          metadata: { createdAt: new Date(), updatedAt: new Date() },
        },
        {
          path: 'dir/doc2.md',
          title: '文書2',
          content: '内容2',
          metadata: { createdAt: new Date(), updatedAt: new Date() },
        },
        {
          path: 'dir/subdir/doc3.md',
          title: '文書3',
          content: '内容3',
          metadata: { createdAt: new Date(), updatedAt: new Date() },
        },
      ];

      for (const doc of documents) {
        await storage.save(doc.path, doc);
      }

      const paths = await storage.list();

      expect(paths).toHaveLength(3);
      expect(paths).toContain('doc1.md');
      expect(paths).toContain('dir/doc2.md');
      expect(paths).toContain('dir/subdir/doc3.md');
    });

    it('文書がない場合は空配列を返す', async () => {
      const paths = await storage.list();
      expect(paths).toEqual([]);
    });
  });

  describe('exists', () => {
    it('存在する文書に対してtrueを返す', async () => {
      const document: Document = {
        path: 'test/document.md',
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);

      const exists = await storage.exists(document.path);
      expect(exists).toBe(true);
    });

    it('存在しない文書に対してfalseを返す', async () => {
      const exists = await storage.exists('non-existent.md');
      expect(exists).toBe(false);
    });
  });

  describe('パス正規化', () => {
    it('バックスラッシュをスラッシュに変換する', async () => {
      const document: Document = {
        path: 'test\\document.md', // Windowsスタイルのパス
        title: 'テスト文書',
        content: 'これはテスト文書です。',
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      await storage.save(document.path, document);

      // 正規化されたパスで取得できる
      const retrieved = await storage.get('test/document.md');
      expect(retrieved).not.toBeNull();
    });
  });

  describe('ハッシュ計算', () => {
    it('内容が同じ場合、同じハッシュが計算される', async () => {
      const content = 'これはテスト文書です。';
      const doc1: Document = {
        path: 'doc1.md',
        title: '文書1',
        content,
        metadata: { createdAt: new Date(), updatedAt: new Date() },
      };
      const doc2: Document = {
        path: 'doc2.md',
        title: '文書2',
        content,
        metadata: { createdAt: new Date(), updatedAt: new Date() },
      };

      await storage.save(doc1.path, doc1);
      await storage.save(doc2.path, doc2);

      const saved1 = await storage.get(doc1.path);
      const saved2 = await storage.get(doc2.path);

      expect(saved1?.metadata.fileHash).toBe(saved2?.metadata.fileHash);
    });

    it('内容が異なる場合、異なるハッシュが計算される', async () => {
      const doc1: Document = {
        path: 'doc1.md',
        title: '文書1',
        content: '内容1',
        metadata: { createdAt: new Date(), updatedAt: new Date() },
      };
      const doc2: Document = {
        path: 'doc2.md',
        title: '文書2',
        content: '内容2',
        metadata: { createdAt: new Date(), updatedAt: new Date() },
      };

      await storage.save(doc1.path, doc1);
      await storage.save(doc2.path, doc2);

      const saved1 = await storage.get(doc1.path);
      const saved2 = await storage.get(doc2.path);

      expect(saved1?.metadata.fileHash).not.toBe(saved2?.metadata.fileHash);
    });
  });
});
