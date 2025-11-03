#!/usr/bin/env node
/**
 * search-docs MCP Server
 * Claude Code統合用のMCPサーバ
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs/promises';

import { detectSystemState } from './state.js';
import { ServerManager } from './server-manager.js';
import {
  registerInitTool,
  registerServerStartTool,
  registerServerStopTool,
  registerSystemStatusTool,
  registerSearchTool,
  registerGetDocumentTool,
  registerIndexStatusTool,
} from './tools/index.js';

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
    .option(
      '--project-dir <path>',
      'Project directory path (optional, will auto-detect from config file if not specified)'
    )
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
  const cwd = projectDir || process.cwd();
  debugLog(`Working directory: ${cwd}`);

  // システム状態を判定
  let systemState = await detectSystemState(cwd);
  debugLog(`System state: ${systemState.state}`);

  // CONFIGURED_SERVER_DOWNかつインデックスが存在する場合、サーバを自動起動
  if (systemState.state === 'CONFIGURED_SERVER_DOWN' && systemState.config) {
    const indexPath = path.join(
      systemState.projectRoot,
      systemState.config.storage.indexPath
    );

    try {
      await fs.access(indexPath);
      // インデックスディレクトリが存在する → 自動起動を試みる
      debugLog('Index directory exists, attempting auto-start...');

      const serverManager = new ServerManager();
      try {
        await serverManager.startServer(
          systemState.projectRoot,
          systemState.config.server.port,
          systemState.configPath
        );

        // 自動起動成功、状態を再判定
        systemState = await detectSystemState(cwd);
        debugLog(`System state after auto-start: ${systemState.state}`);
      } catch (startError) {
        // 自動起動失敗は致命的ではない、手動起動を促す
        debugLog(`Auto-start failed: ${(startError as Error).message}`);
      }
    } catch {
      // インデックスディレクトリが存在しない → 自動起動しない
      debugLog('Index directory does not exist, skipping auto-start');
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

  // ツール登録コンテキスト
  const context = { server, systemState };

  // 状態に応じてツールを登録
  switch (systemState.state) {
    case 'NOT_CONFIGURED':
      // 未設定状態: init, get_system_status のみ
      debugLog('Registering tools for NOT_CONFIGURED state');
      registerInitTool(context);
      registerSystemStatusTool(context);
      break;

    case 'CONFIGURED_SERVER_DOWN':
      // 設定済み・サーバ停止状態: init, server_start, server_stop, get_system_status
      debugLog('Registering tools for CONFIGURED_SERVER_DOWN state');
      registerInitTool(context);
      registerServerStartTool(context);
      registerServerStopTool(context);
      registerSystemStatusTool(context);
      break;

    case 'RUNNING':
      // 稼働中: 全ツール
      debugLog('Registering all tools for RUNNING state');
      registerInitTool(context);
      registerServerStartTool(context);
      registerServerStopTool(context);
      registerSystemStatusTool(context);
      registerSearchTool(context);
      registerGetDocumentTool(context);
      registerIndexStatusTool(context);
      break;
  }

  // サーバの起動
  const transport = new StdioServerTransport();
  debugLog('Starting MCP server...');
  await server.connect(transport);
  debugLog(`MCP server started (state: ${systemState.state})`);
}

main().catch((error) => {
  console.error('[mcp-server] Server error:', error);
  process.exit(1);
});
