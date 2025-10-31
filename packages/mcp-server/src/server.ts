#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Command } from 'commander';
import { SearchDocsClient } from '@search-docs/client';
import { ConfigLoader } from '@search-docs/types';
import * as path from 'path';
import { ServerManager } from './server-manager.js';
import { createRequire } from 'module';

// package.jsonからバージョンを読み込む
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const VERSION = packageJson.version;

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
 * depthを分かりやすいラベルに変換
 */
function getDepthLabel(depth: number): string {
  const labels = [
    'document (全体)',
    'H1 (章)',
    'H2 (節)',
    'H3 (項)',
  ];
  return labels[depth] || `depth-${depth}`;
}

/**
 * コンテンツのプレビューを取得（行ベース）
 */
function getPreviewContent(content: string, maxLines: number = 5): string {
  const lines = content.split('\n');

  if (lines.length <= maxLines) {
    return content;
  }

  const previewLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  previewLines.push(`... (残り${remaining}行)`);

  return previewLines.join('\n');
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
    .version(VERSION)
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
      version: VERSION,
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
        previewLines: z.number().optional().describe('プレビュー行数（デフォルト: 5）'),
      },
    },
    async (args: {
      query: string;
      depth?: number | number[];
      limit?: number;
      includeCleanOnly?: boolean;
      previewLines?: number;
    }) => {
      const { query, depth, limit, includeCleanOnly, previewLines = 5 } = args;

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
            // ヘッダー行
            const heading = result.heading || '(no heading)';
            resultText += `${index + 1}. ${result.documentPath} > ${heading}\n`;

            // メタデータ（1行にまとめる）
            const depthLabel = getDepthLabel(result.depth);
            const sectionPath = result.sectionNumber.join('-');
            const metaParts = [
              `Level: ${depthLabel}`,
              `Section: ${sectionPath}`,
              `Line: ${result.startLine}-${result.endLine}`,
              `Score: ${result.score.toFixed(4)}`,
            ];

            // indexStatusが'updating'または'outdated'の場合のみ表示
            if (result.indexStatus === 'updating' || result.indexStatus === 'outdated') {
              metaParts.push(`Status: ${result.indexStatus}`);
            }

            resultText += metaParts.join(' | ') + '\n\n';

            // コンテンツ（引用として明確に）
            resultText += '```markdown\n';
            const preview = getPreviewContent(result.content, previewLines);
            resultText += preview + '\n';
            resultText += '```\n\n';

            // セクションID（get_documentで取得するため）
            resultText += `(セクションID: ${result.id})\n\n`;
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
      description: '文書の内容を取得します。パス指定で文書全体、またはセクションIDで特定セクションを取得できます。',
      inputSchema: {
        path: z.string().describe('文書パス'),
        sectionId: z.string().optional().describe('セクションID（検索結果から取得）'),
      },
    },
    async (args: { path: string; sectionId?: string }) => {
      const { path: documentPath, sectionId } = args;

      try {
        const response = await client.getDocument({ path: documentPath, sectionId });

        if (!response.document) {
          throw new Error(`Document not found: ${documentPath}`);
        }

        let resultText = '';

        // セクション取得の場合
        if (sectionId && response.section) {
          resultText += `セクション: ${response.section.heading || '(no heading)'}\n`;
          resultText += `文書: ${response.section.documentPath}\n`;
          const depthLabel = getDepthLabel(response.section.depth);
          const sectionPath = response.section.sectionNumber.join('-');
          resultText += `Level: ${depthLabel} | Section: ${sectionPath} | Line: ${response.section.startLine}-${response.section.endLine}\n\n`;
          resultText += `内容:\n${'='.repeat(60)}\n`;
          resultText += response.section.content;
          resultText += `\n${'='.repeat(60)}`;
        } else {
          // 文書全体取得の場合
          resultText += `文書: ${response.document.path}\n`;
          if (response.document.metadata.title) {
            resultText += `タイトル: ${response.document.metadata.title}\n`;
          }
          resultText += `作成日: ${new Date(response.document.metadata.createdAt).toLocaleString()}\n`;
          resultText += `更新日: ${new Date(response.document.metadata.updatedAt).toLocaleString()}\n\n`;
          resultText += `内容:\n${'='.repeat(60)}\n`;
          resultText += response.document.content;
          resultText += `\n${'='.repeat(60)}`;
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
