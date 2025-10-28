/**
 * SearchDocsClient テスト
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SearchDocsClient, JsonRpcClientError } from '../client.js';

describe('SearchDocsClient', () => {
  describe('インスタンス作成', () => {
    it('デフォルト設定で作成できる', () => {
      const client = new SearchDocsClient();
      expect(client).toBeInstanceOf(SearchDocsClient);
    });

    it('カスタム設定で作成できる', () => {
      const client = new SearchDocsClient({
        baseUrl: 'http://example.com:8080',
        timeout: 5000,
      });
      expect(client).toBeInstanceOf(SearchDocsClient);
    });
  });

  describe('エラーハンドリング', () => {
    it('JsonRpcClientError を作成できる', () => {
      const error = new JsonRpcClientError('Test error', -32600, { detail: 'test' });
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(JsonRpcClientError);
      expect(error.message).toBe('Test error');
      expect(error.code).toBe(-32600);
      expect(error.data).toEqual({ detail: 'test' });
      expect(error.name).toBe('JsonRpcClientError');
    });
  });

  describe('サーバとの統合テスト', () => {
    let client: SearchDocsClient;
    const testServerUrl = process.env.TEST_SERVER_URL || 'http://localhost:24280';

    beforeAll(() => {
      client = new SearchDocsClient({ baseUrl: testServerUrl });
    });

    it.skip('ヘルスチェックが成功する', async () => {
      const health = await client.healthCheck();
      expect(health).toBeDefined();
    });

    it.skip('ステータス取得が成功する', async () => {
      const status = await client.getStatus();
      expect(status.server).toBeDefined();
      expect(status.server.version).toBeDefined();
      expect(status.index).toBeDefined();
      expect(status.worker).toBeDefined();
    });

    it.skip('検索が実行できる', async () => {
      const result = await client.search({
        query: 'test',
        options: {
          limit: 5,
        },
      });
      expect(result.results).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
    });

    it.skip('タイムアウトエラーが発生する', async () => {
      const slowClient = new SearchDocsClient({
        baseUrl: testServerUrl,
        timeout: 1, // 1ms
      });

      await expect(
        slowClient.search({ query: 'test' })
      ).rejects.toThrow('Request timeout');
    }, 10000);
  });

  describe('メソッド呼び出し', () => {
    it('search メソッドが呼び出せる', () => {
      const client = new SearchDocsClient({ baseUrl: 'http://example.com' });
      // 接続先がないのでエラーになるが、メソッド自体は存在する
      expect(typeof client.search).toBe('function');
    });

    it('getDocument メソッドが呼び出せる', () => {
      const client = new SearchDocsClient({ baseUrl: 'http://example.com' });
      expect(typeof client.getDocument).toBe('function');
    });

    it('indexDocument メソッドが呼び出せる', () => {
      const client = new SearchDocsClient({ baseUrl: 'http://example.com' });
      expect(typeof client.indexDocument).toBe('function');
    });

    it('rebuildIndex メソッドが呼び出せる', () => {
      const client = new SearchDocsClient({ baseUrl: 'http://example.com' });
      expect(typeof client.rebuildIndex).toBe('function');
    });

    it('getStatus メソッドが呼び出せる', () => {
      const client = new SearchDocsClient({ baseUrl: 'http://example.com' });
      expect(typeof client.getStatus).toBe('function');
    });

    it('healthCheck メソッドが呼び出せる', () => {
      const client = new SearchDocsClient({ baseUrl: 'http://example.com' });
      expect(typeof client.healthCheck).toBe('function');
    });
  });
});
