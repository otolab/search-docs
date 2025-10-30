#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Command } from 'commander';
import { SearchDocsClient } from '@search-docs/client';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 設定ファイルの型
 */
interface SearchDocsConfig {
  server: {
    host: string;
    port: number;
  };
}

/**
 * デフォルト設定
 */
const DEFAULT_CONFIG: SearchDocsConfig = {
  server: {
    host: 'localhost',
    port: 24280,
  },
};

/**
 * 設定ファイルを読み込む
 */
async function loadConfig(projectDir: string): Promise<SearchDocsConfig> {
  const configPath = path.join(projectDir, '.search-docs.json');

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as SearchDocsConfig;
    return {
      server: {
        host: config.server?.host || DEFAULT_CONFIG.server.host,
        port: config.server?.port || DEFAULT_CONFIG.server.port,
      },
    };
  } catch (_error) {
    console.error(`[mcp-server] Config file not found or invalid, using defaults: ${configPath}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * CLIオプション
 */
interface CLIOptions {
  projectDir: string;
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
    .requiredOption('--project-dir <path>', 'Project directory path')
    .parse(process.argv);

  const options = program.opts<{ projectDir: string }>();

  return {
    projectDir: path.resolve(options.projectDir),
  };
}

/**
 * メイン処理
 */
async function main() {
  // コマンドライン引数の解析
  const { projectDir } = parseArgs();
  console.error(`[mcp-server] Project directory: ${projectDir}`);

  // 設定ファイルの読み込み
  const config = await loadConfig(projectDir);
  const serverUrl = `http://${config.server.host}:${config.server.port}`;
  console.error(`[mcp-server] Server URL: ${serverUrl}`);

  // SearchDocsClientの初期化
  const client = new SearchDocsClient({ baseUrl: serverUrl });

  // 接続確認
  try {
    await client.healthCheck();
    console.error('[mcp-server] Connection to search-docs server established');
  } catch (error) {
    console.error('[mcp-server] Failed to connect to search-docs server');
    console.error('[mcp-server] Please ensure the server is running with:');
    console.error(`[mcp-server]   node packages/cli/dist/index.js server start`);
    throw error;
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
  console.error('[mcp-server] Starting MCP server...');
  await server.connect(transport);
  console.error('[mcp-server] MCP server started');
}

main().catch((error) => {
  console.error('[mcp-server] Server error:', error);
  process.exit(1);
});
