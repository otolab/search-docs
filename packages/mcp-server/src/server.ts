#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Command } from 'commander';
import { SearchDocsClient } from '@search-docs/client';
import { ConfigLoader } from '@search-docs/types';
import * as path from 'path';
import { ServerManager } from './server-manager.js';

/**
 * デバッグモードの判定
 */
const isDebugMode = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

/**
 * デバッグログ出力（デバッグモード時のみ）
 */
function debugLog(message: string): void {
  if (isDebugMode) {
    console.error(`[mcp-server] ${message}`);
  }
}

/**
 * CLIオプション
 */
interface CLIOptions {
  projectDir?: string;
}

/**
 * コマンドライン引数を解析
 */
function parseArgs(): CLIOptions {
  const program = new Command();

  program
    .name('search-docs-mcp')
    .description('MCP Server for search-docs - Claude Code integration')
    .version('0.1.0')
    .option('--project-dir <path>', 'Project directory path (optional, will auto-detect from config file if not specified)')
    .parse(process.argv);

  const options = program.opts<{ projectDir?: string }>();

  return {
    projectDir: options.projectDir ? path.resolve(options.projectDir) : undefined,
  };
}

/**
 * メイン処理
 */
async function main() {
  // コマンドライン引数の解析
  const { projectDir } = parseArgs();

  // プロジェクトディレクトリを決定
  // 明示的に指定されていない場合は、カレントディレクトリから設定ファイルを探索
  const cwd = projectDir || process.cwd();
  debugLog(`Working directory: ${cwd}`);
  if (projectDir) {
    debugLog(`Project directory (explicit): ${projectDir}`);
  } else {
    debugLog(`Project directory: auto-detect from config file`);
  }

  // 設定ファイルの読み込み
  const { config, configPath, projectRoot } = await ConfigLoader.resolve({
    cwd,
    requireConfig: true,
  });
  const serverUrl = `http://${config.server.host}:${config.server.port}`;
  debugLog(`Project root: ${projectRoot}`);
  debugLog(`Config: ${configPath || 'default config'}`);
  debugLog(`Server URL: ${serverUrl}`);

  // SearchDocsClientの初期化
  const client = new SearchDocsClient({ baseUrl: serverUrl });

  // ServerManager初期化
  const serverManager = new ServerManager();

  // プロセス終了時のクリーンアップ
  process.on('SIGINT', () => {
    debugLog('Received SIGINT, cleaning up...');
    serverManager.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    debugLog('Received SIGTERM, cleaning up...');
    serverManager.cleanup();
    process.exit(0);
  });

  // 接続確認
  try {
    await client.healthCheck();
    debugLog('Connection to search-docs server established');
  } catch (_error) {
    debugLog('Server is not running, attempting to start...');

    try {
      // サーバを自動起動（projectRootを使用）
      await serverManager.startServer(projectRoot, config.server.port, configPath || undefined);

      // 起動後、再度接続確認
      await client.healthCheck();
      debugLog('Successfully connected to auto-started server');
    } catch (startError) {
      // エラーは標準エラー出力に出す（ユーザーが問題解決に必要）
      console.error('[mcp-server] Failed to auto-start server');
      console.error('[mcp-server] Error:', (startError as Error).message);
      console.error('[mcp-server] Please ensure @search-docs/cli is installed:');
      console.error('[mcp-server]   npm install -g @search-docs/cli');
      throw startError;
    }
  }

  // MCPサーバの初期化
  const server = new McpServer(
    {
      name: 'search-docs',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // search ツール
  server.registerTool(
    'search',
    {
      description: '文書を検索します。クエリに基づいてVector検索を実行し、関連する文書セクションを返します。',
      inputSchema: {
        query: z.string().describe('検索クエリ'),
        depth: z
          .union([z.number(), z.array(z.number())])
          .optional()
          .describe('検索深度（0-3）。配列で複数指定可能'),
        limit: z.number().optional().describe('結果数制限（デフォルト: 10）'),
        includeCleanOnly: z
          .boolean()
          .optional()
          .describe('Clean状態のセクションのみを検索対象とする（デフォルト: false）'),
      },
    },
    async (args: { query: string; depth?: number | number[]; limit?: number; includeCleanOnly?: boolean }) => {
      const { query, depth, limit, includeCleanOnly } = args;

      try {
        const response = await client.search({
          query,
          options: {
            depth,
            limit,
            includeCleanOnly,
          },
        });

        // 結果を整形
        let resultText = `検索結果: ${response.total}件\n`;
        resultText += `処理時間: ${response.took}ms\n\n`;

        if (response.results.length === 0) {
          resultText += '該当する結果が見つかりませんでした。';
        } else {
          response.results.forEach((result, index) => {
            resultText += `${index + 1}. ${result.documentPath}\n`;
            resultText += `   見出し: ${result.heading}\n`;
            resultText += `   深度: ${result.depth}\n`;
            resultText += `   スコア: ${result.score.toFixed(4)}\n`;
            resultText += `   Dirty: ${result.isDirty ? 'Yes' : 'No'}\n`;
            resultText += `   内容プレビュー: ${result.content.substring(0, 100)}...\n\n`;
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`検索エラー: ${(error as Error).message}`);
      }
    }
  );

  // get_document ツール
  server.registerTool(
    'get_document',
    {
      description: '文書の内容を取得します。パス指定で文書全体またはセクションを取得できます。',
      inputSchema: {
        path: z.string().describe('文書パス'),
      },
    },
    async (args: { path: string }) => {
      const { path: documentPath } = args;

      try {
        const response = await client.getDocument({ path: documentPath });

        let resultText = `文書: ${response.document.path}\n`;
        if (response.document.metadata.title) {
          resultText += `タイトル: ${response.document.metadata.title}\n`;
        }
        resultText += `作成日: ${new Date(response.document.metadata.createdAt).toLocaleString()}\n`;
        resultText += `更新日: ${new Date(response.document.metadata.updatedAt).toLocaleString()}\n\n`;
        resultText += `内容:\n${'='.repeat(60)}\n`;
        resultText += response.document.content;
        resultText += `\n${'='.repeat(60)}`;

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`文書取得エラー: ${(error as Error).message}`);
      }
    }
  );

  // index_status ツール
  server.registerTool(
    'index_status',
    {
      description: 'インデックスの状態を確認します。総文書数、セクション数、Dirtyセクション数などを表示します。',
      inputSchema: {},
    },
    async () => {
      try {
        const response = await client.getStatus();

        let statusText = '📊 インデックス状態\n\n';
        statusText += `サーバ情報:\n`;
        statusText += `  バージョン: ${response.server.version}\n`;
        statusText += `  起動時間: ${(response.server.uptime / 1000).toFixed(1)}秒\n`;
        statusText += `  PID: ${response.server.pid}\n\n`;

        statusText += `インデックス情報:\n`;
        statusText += `  総文書数: ${response.index.totalDocuments}件\n`;
        statusText += `  総セクション数: ${response.index.totalSections}件\n`;
        statusText += `  Dirtyセクション: ${response.index.dirtyCount}件\n`;

        if (response.worker) {
          statusText += `\nワーカー情報:\n`;
          statusText += `  実行中: ${response.worker.running ? 'Yes' : 'No'}\n`;
          statusText += `  処理中: ${response.worker.processing}件\n`;
          statusText += `  キュー: ${response.worker.queue}件\n`;
        }

        return {
          content: [
            {
              type: 'text',
              text: statusText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`ステータス取得エラー: ${(error as Error).message}`);
      }
    }
  );

  // サーバの起動
  const transport = new StdioServerTransport();
  debugLog('Starting MCP server...');
  await server.connect(transport);
  debugLog('MCP server started');
}

main().catch((error) => {
  console.error('[mcp-server] Server error:', error);
  process.exit(1);
});
