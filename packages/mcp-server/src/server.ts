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

import { detectSystemState } from './state.js';
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
  const systemState = await detectSystemState(cwd);
  debugLog(`System state: ${systemState.state}`);

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
