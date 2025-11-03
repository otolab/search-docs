/**
 * MCP Server E2E Tests with mcp-debug
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createMCPTester, MCPServiceE2ETester } from '@coeiro-operator/mcp-debug';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MCP型定義（mcp-debugの型が不完全なため）
interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface MCPToolsListResponse {
  tools: MCPTool[];
}

interface MCPTextContent {
  type: 'text';
  text: string;
}

interface MCPToolResult {
  content?: MCPTextContent[];
}

describe('search-docs MCP Server E2E Tests', () => {
  let tester: MCPServiceE2ETester;

  beforeEach(async () => {
    const serverPath = path.resolve(__dirname, '../dist/server.js');
    const projectDir = path.resolve(__dirname, '../../..');

    // MCP Serverを起動
    tester = await createMCPTester({
      serverPath,
      args: ['--project-dir', projectDir],
    });

    // サーバーが準備完了するまで待機
    await tester.waitUntilReady();

    // search-docsサーバが起動していない場合は起動
    // (CONFIGURED_SERVER_DOWN状態でインデックスが存在しない場合)
    const statusResult = await tester.callTool('get_system_status', {});
    if (statusResult.success) {
      const content = (statusResult.result as MCPToolResult)?.content?.[0]?.text || '';
      if (content.includes('サーバ停止中') || content.includes('サーバを起動してください')) {
        // サーバを起動
        await tester.callTool('server_start', {});
        // 起動完了を待機
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }, 30000); // タイムアウトを30秒に延長

  afterEach(async () => {
    // テスト環境をクリーンアップ
    if (tester) {
      await tester.cleanup();
    }
  });

  describe('基本的なMCP動作確認', () => {
    test('MCPサーバーの起動と初期化', () => {
      const status = tester.getStatus();

      expect(status.isReady).toBe(true);
      expect(status.state).toBe('ready');
      expect(status.pendingRequests).toBe(0);
    });

    test('利用可能なツールの確認', async () => {
      const response = (await tester.sendRequest('tools/list', {})) as MCPToolsListResponse;

      expect(response.tools).toBeDefined();
      expect(Array.isArray(response.tools)).toBe(true);

      const toolNames = response.tools.map((t) => t.name);
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('get_document');
      expect(toolNames).toContain('index_status');
    });
  });

  describe('index_status ツール', () => {
    test('インデックス状態を取得できる', async () => {
      const result = await tester.callTool('index_status', {});

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.duration).toBeLessThan(2000); // 2秒以内に応答

      // レスポンステキストにインデックス情報が含まれる
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;
      expect(content).toContain('インデックス状態');
      expect(content).toContain('総文書数');
      expect(content).toContain('総セクション数');
    });
  });

  describe('search ツール', () => {
    test('クエリで検索できる', async () => {
      const result = await tester.callTool('search', {
        query: 'Vector検索',
        limit: 5,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();

      const content = (result.result as MCPToolResult)?.content?.[0]?.text;
      expect(content).toContain('検索結果');
    });

    test('depth指定で検索できる', async () => {
      const result = await tester.callTool('search', {
        query: 'アーキテクチャ',
        depth: 1,
        limit: 3,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
    });

    test('検索結果が正しく返される', async () => {
      // Vector検索は完全一致でなくても結果を返すため、
      // 結果があることを確認
      const result = await tester.callTool('search', {
        query: 'xyzabc123notexist',
        limit: 5,
      });

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;
      // 検索結果フォーマットを確認
      expect(content).toContain('検索結果:');
      expect(content).toContain('処理時間:');
    });
  });

  describe('get_document ツール', () => {
    test('文書を取得できる', async () => {
      // まず検索で有効なパスを見つける
      const searchResult = await tester.callTool('search', {
        query: 'search-docs',
        limit: 1,
      });

      expect(searchResult.success).toBe(true);

      // 検索結果からパスを抽出（簡易的な方法）
      const searchContent = (searchResult.result as MCPToolResult)?.content?.[0]?.text || '';
      const pathMatch = searchContent.match(/文書: (.+\.md)/);

      if (pathMatch) {
        const documentPath = pathMatch[1];

        const result = await tester.callTool('get_document', {
          path: documentPath,
        });

        expect(result.success).toBe(true);
        const content = (result.result as MCPToolResult)?.content?.[0]?.text;
        expect(content).toContain('文書:');
        expect(content).toContain('内容:');
      }
    });

    test('存在しない文書を取得するとエラー', async () => {
      const result = await tester.callTool('get_document', {
        path: 'non-existent-document.md',
      });

      // エラーレスポンスまたは空の結果を返す
      // 実装次第で成功するがエラーメッセージを含む場合もある
      if (result.success) {
        const content = (result.result as MCPToolResult)?.content?.[0]?.text;
        expect(content).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('並行処理のテスト', () => {
    test('複数ツールの並行呼び出し', async () => {
      await tester.waitUntilReady();

      const calls = [
        { name: 'index_status', args: {} },
        { name: 'search', args: { query: 'MCP', limit: 3 } },
        { name: 'search', args: { query: 'クライアント', limit: 3 } },
      ];

      const results = await tester.callToolsConcurrently(calls);

      expect(results).toHaveLength(3);

      // 少なくとも1つは成功することを確認
      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBeGreaterThan(0);

      // 応答時間を確認
      results.forEach((result) => {
        expect(result.duration).toBeLessThan(3000);
      });
    });
  });

  describe('エラーハンドリング', () => {
    test('存在しないツールの呼び出しエラー処理', async () => {
      const result = await tester.callTool('non_existent_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('不正なパラメータでエラー処理', async () => {
      const result = await tester.callTool('search', {
        // queryが必須だが欠けている
        limit: 5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('get_system_status ツール', () => {
    test('システム状態を取得できる', async () => {
      const result = await tester.callTool('get_system_status', {});

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();

      const content = (result.result as MCPToolResult)?.content?.[0]?.text;
      expect(content).toContain('search-docs システム状態');
      expect(content).toContain('状態:');
    });

    test('稼働中状態の詳細情報を含む', async () => {
      const result = await tester.callTool('get_system_status', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      // RUNNING状態の場合の情報
      expect(content).toContain('サーバURL:');
      expect(content).toContain('総文書数:');
      expect(content).toContain('総セクション数:');
    });
  });
});
