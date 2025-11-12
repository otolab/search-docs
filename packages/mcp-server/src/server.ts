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

import { detectSystemState, type SystemState } from './state.js';
import { ServerManager } from './server-manager.js';
import {
  registerInitTool,
  registerServerStartTool,
  registerServerStopTool,
  registerSystemStatusTool,
  registerSearchTool,
  registerGetDocumentTool,
  registerIndexStatusTool,
  type RegisteredTool,
} from './tools/index.js';

// package.jsonからバージョンを読み込む
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
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

  // Always write to debug file for troubleshooting
  try {
    const debugFile = '/tmp/mcp-server-debug.log';
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [mcp-server] ${message}\n`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    require('fs').appendFileSync(debugFile, logMessage);
  } catch {
    // Ignore file write errors
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
 * ツールハンドル
 */
interface ToolHandles {
  init: RegisteredTool;
  serverStart: RegisteredTool;
  serverStop: RegisteredTool;
  systemStatus: RegisteredTool;
  search: RegisteredTool;
  getDocument: RegisteredTool;
  indexStatus: RegisteredTool;
}

/**
 * ツールの有効/無効を更新
 *
 * シンプルな2状態モデル:
 * - NOT_CONFIGURED: init, get_system_status のみ
 * - CONFIGURED (SERVER_DOWN/RUNNING): 全ツール有効
 *
 * 各ツール内で状態チェックを行い、適切なエラーメッセージを返す
 */
function updateToolAvailability(state: SystemState, handles: ToolHandles): void {
  debugLog(`Updating tool availability for state: ${state}`);

  if (state === 'NOT_CONFIGURED') {
    // 未設定状態: init, get_system_status のみ
    handles.init.enable();
    handles.systemStatus.enable();
    handles.serverStart.disable();
    handles.serverStop.disable();
    handles.search.disable();
    handles.getDocument.disable();
    handles.indexStatus.disable();
    debugLog('Tools enabled: init, systemStatus');
  } else {
    // 設定済み（サーバ起動状態に関わらず全ツール有効）
    // 各ツール内で状態チェックを行う
    handles.init.enable();
    handles.serverStart.enable();
    handles.serverStop.enable();
    handles.systemStatus.enable();
    handles.search.enable();
    handles.getDocument.enable();
    handles.indexStatus.enable();
    debugLog('All tools enabled (configured state)');
  }
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
  debugLog('='.repeat(60));
  debugLog(`System state detected: ${systemState.state}`);
  debugLog(`Project root: ${systemState.projectRoot}`);
  debugLog(`Config exists: ${systemState.config ? 'YES' : 'NO'}`);
  debugLog(`Config path: ${systemState.configPath || '(none)'}`);

  // CONFIGURED_SERVER_DOWNかつインデックスが存在する場合、サーバを自動起動
  debugLog(`Checking auto-start condition: state === CONFIGURED_SERVER_DOWN && config exists`);
  debugLog(`  - state === CONFIGURED_SERVER_DOWN: ${systemState.state === 'CONFIGURED_SERVER_DOWN'}`);
  debugLog(`  - config exists: ${!!systemState.config}`);

  if (systemState.state === 'CONFIGURED_SERVER_DOWN' && systemState.config) {
    const indexPath = path.join(
      systemState.projectRoot,
      systemState.config.storage.indexPath
    );
    debugLog(`Index path to check: ${indexPath}`);

    try {
      await fs.access(indexPath);
      // インデックスディレクトリが存在する → 自動起動を試みる
      debugLog('✓ Index directory exists, attempting auto-start...');

      const serverManager = new ServerManager();
      try {
        debugLog(`Auto-start params: projectRoot=${systemState.projectRoot}, port=${systemState.config.server.port}, configPath=${systemState.configPath}`);
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
    } catch (error) {
      // インデックスディレクトリが存在しない → 自動起動しない
      debugLog(`✗ Index directory does not exist, skipping auto-start: ${(error as Error).message}`);
    }
  } else {
    debugLog('✗ Auto-start condition not met, skipping auto-start');
  }
  debugLog('='.repeat(60));

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

  // ツールハンドルを保持する変数
  let toolHandles: ToolHandles | null = null;

  // システム状態を再検出する関数
  const refreshSystemState = async () => {
    const newState = await detectSystemState(cwd);
    // systemStateオブジェクトのプロパティを更新
    Object.assign(systemState, newState);
    debugLog(`System state refreshed: ${systemState.state}`);

    // ツールの有効/無効を更新
    if (toolHandles) {
      updateToolAvailability(systemState.state, toolHandles);
    }
  };

  // ツール登録コンテキスト
  const context = { server, systemState, refreshSystemState };

  // 全ツールを登録
  debugLog('Registering all tools...');
  toolHandles = {
    init: registerInitTool(context),
    serverStart: registerServerStartTool(context),
    serverStop: registerServerStopTool(context),
    systemStatus: registerSystemStatusTool(context),
    search: registerSearchTool(context),
    getDocument: registerGetDocumentTool(context),
    indexStatus: registerIndexStatusTool(context),
  };

  // 初期状態に応じてツールの有効/無効を設定
  updateToolAvailability(systemState.state, toolHandles);

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
