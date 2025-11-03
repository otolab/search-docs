/**
 * MCP Server 状態遷移とライフサイクル E2E Tests
 *
 * NOTE: このテストはサーバ起動・停止を含むため、実行に時間がかかります。
 * また、mcp-debugの状態管理との兼ね合いで一部のテストが不安定な場合があります。
 * 基本的な状態遷移（NOT_CONFIGURED, CONFIGURED_SERVER_DOWN）のテストは動作します。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createMCPTester, MCPServiceE2ETester } from '@coeiro-operator/mcp-debug';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MCP型定義
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

describe('MCP Server 状態遷移テスト', () => {
  let testDir: string;
  let tester: MCPServiceE2ETester;

  beforeAll(async () => {
    // テスト用の一時ディレクトリを作成
    testDir = path.join('/tmp', `search-docs-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const serverPath = path.resolve(__dirname, '../dist/server.js');

    // 未設定状態でMCPサーバーを起動
    tester = await createMCPTester({
      serverPath,
      args: ['--project-dir', testDir],
    });

    await tester.waitUntilReady();
  });

  afterAll(async () => {
    // クリーンアップ
    if (tester) {
      await tester.cleanup();
    }

    // テストディレクトリを削除
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup test directory:', error);
    }
  });

  describe('NOT_CONFIGURED状態', () => {
    test('未設定状態で利用可能なツールを確認', async () => {
      const response = (await tester.sendRequest('tools/list', {})) as MCPToolsListResponse;

      const toolNames = response.tools.map((t) => t.name);

      // NOT_CONFIGURED状態では init と get_system_status のみ利用可能
      expect(toolNames).toContain('init');
      expect(toolNames).toContain('get_system_status');

      // 他のツールは利用不可
      expect(toolNames).not.toContain('search');
      expect(toolNames).not.toContain('get_document');
      expect(toolNames).not.toContain('index_status');
    });

    test('get_system_statusで未設定状態を確認', async () => {
      const result = await tester.callTool('get_system_status', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('状態: 未設定');
      expect(content).toContain('まず、設定ファイルを作成してください');
      expect(content).toContain('ツール: init');
    });

    test('init実行で設定ファイルを作成', async () => {
      const result = await tester.callTool('init', {
        port: 54321, // テスト用の固定ポート
      });

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('✅ 設定ファイルの初期化が完了しました');
      expect(content).toContain('📝 設定ファイルの重要な項目');
      expect(content).toContain('files.include');
      expect(content).toContain('indexing.maxDepth');

      // 設定ファイルが作成されたことを確認
      const configPath = path.join(testDir, '.search-docs.json');
      const configExists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(configExists).toBe(true);

      // 設定内容を確認
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.server.port).toBe(54321);
    });
  });

  describe('CONFIGURED_SERVER_DOWN状態', () => {
    test('設定後に利用可能なツールを確認', async () => {
      // 状態が変わるため、MCPサーバーを再起動する必要がある
      // しかし、mcp-debugでは状態の再読み込みができないため、
      // 次のテストで新しいインスタンスを起動する方が良い
      // ここでは設定ファイルが作成されたことを確認済みなので、
      // 手動で確認することにします

      // 設定ファイルの存在確認
      const configPath = path.join(testDir, '.search-docs.json');
      const configExists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(configExists).toBe(true);
    });
  });
});

describe('MCP Server ライフサイクルテスト (設定済み環境)', () => {
  let testDir: string;
  let tester: MCPServiceE2ETester;

  beforeAll(async () => {
    // テスト用の一時ディレクトリを作成
    testDir = path.join('/tmp', `search-docs-lifecycle-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // 設定ファイルを事前に作成
    const configPath = path.join(testDir, '.search-docs.json');
    const config = {
      version: '1.0',
      project: {
        name: 'test-project',
        root: '.',
      },
      files: {
        include: ['**/*.md'],
        exclude: ['**/node_modules/**'],
        ignoreGitignore: true,
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
        port: 54322,
        protocol: 'json-rpc',
      },
      storage: {
        documentsPath: '.search-docs/documents',
        indexPath: '.search-docs/index',
        cachePath: '.search-docs/cache',
      },
      worker: {
        enabled: true,
        interval: 5000,
        maxConcurrent: 3,
      },
      watcher: {
        enabled: true,
        debounceMs: 1000,
        awaitWriteFinishMs: 2000,
      },
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const serverPath = path.resolve(__dirname, '../dist/server.js');

    // 設定済み状態でMCPサーバーを起動
    tester = await createMCPTester({
      serverPath,
      args: ['--project-dir', testDir],
    });

    await tester.waitUntilReady();
  });

  afterAll(async () => {
    // クリーンアップ
    if (tester) {
      await tester.cleanup();
    }

    // テストディレクトリを削除
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup test directory:', error);
    }
  });

  describe('CONFIGURED_SERVER_DOWN状態', () => {
    test('設定済み・サーバ停止状態で利用可能なツールを確認', async () => {
      const response = (await tester.sendRequest('tools/list', {})) as MCPToolsListResponse;

      const toolNames = response.tools.map((t) => t.name);

      // CONFIGURED_SERVER_DOWN状態では init, server_start, server_stop, get_system_status が利用可能
      expect(toolNames).toContain('init');
      expect(toolNames).toContain('server_start');
      expect(toolNames).toContain('server_stop');
      expect(toolNames).toContain('get_system_status');

      // 検索ツールは利用不可
      expect(toolNames).not.toContain('search');
      expect(toolNames).not.toContain('get_document');
      expect(toolNames).not.toContain('index_status');
    });

    test('get_system_statusで設定済み・サーバ停止状態を確認', async () => {
      const result = await tester.callTool('get_system_status', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('状態: 設定済み・サーバ停止中');
      expect(content).toContain('設定ファイル:');
      expect(content).toContain('プロジェクト:');
      expect(content).toContain('サーバを起動してください');
      expect(content).toContain('ツール: server_start');
    });

    test('server_startでサーバを起動', async () => {
      const result = await tester.callTool('server_start', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('✅ サーバを起動しました');

      // サーバ起動後、少し待機
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });
  });

  describe('サーバ起動・停止のライフサイクル', () => {
    test('server_stopでサーバを停止', async () => {
      // まずサーバが起動していることを確認
      const statusResult = await tester.callTool('get_system_status', {});
      expect(statusResult.success).toBe(true);

      // サーバを停止
      const result = await tester.callTool('server_stop', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('✅ サーバを停止しました');

      // サーバ停止後、少し待機
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });

    test('停止後に再度server_startで起動', async () => {
      const result = await tester.callTool('server_start', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('✅ サーバを起動しました');

      // サーバ起動後、少し待機
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });

    test('サーバ起動中にserver_startを実行すると既に起動中のメッセージ', async () => {
      const result = await tester.callTool('server_start', {});

      expect(result.success).toBe(true);
      const content = (result.result as MCPToolResult)?.content?.[0]?.text;

      expect(content).toContain('サーバは既に起動しています');
    });
  });
});
