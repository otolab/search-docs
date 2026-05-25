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
import { setupLogRedirect } from '@search-docs/server';

import { detectSystemState, createService, stopService, type SystemState, type ServiceInstances } from './state.js';
import { ServerManager } from './server-manager.js';
import {
  registerInitTool,
  registerSystemStatusTool,
  registerSearchTool,
  registerGetDocumentTool,
  registerGetOutlineTool,
  registerIndexStatusTool,
  registerListRelatedProjectsTool,
  registerAddRelatedProjectTool,
  type RegisteredTool,
} from './tools/index.js';
import { registerResources } from './resources/index.js';

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
  systemStatus: RegisteredTool;
  search: RegisteredTool;
  getDocument: RegisteredTool;
  getOutline: RegisteredTool;
  indexStatus: RegisteredTool;
  listRelatedProjects: RegisteredTool;
  addRelatedProject: RegisteredTool;
}

/**
 * ツールの有効/無効を更新
 *
 * 現在は全ツールを常時有効にし、各ツール内で状態チェックを行う。
 * NOT_CONFIGURED状態でもadd_related_projectで関連プロジェクトを追加し、
 * 検索等を利用できるようにするため。
 *
 * TODO: Claude Codeがnotifications/tools/list_changed に対応した場合、
 * 状態に応じたenable/disable制御を有効化する。
 * 現在はClaude Codeが未対応のため、disableしてもツールリストに反映されない。
 */
function updateToolAvailability(_state: SystemState, handles: ToolHandles): void {
  debugLog(`Updating tool availability for state: ${_state}`);

  // 全ツールを常時有効にする
  // 各ツール内で状態チェックを行い、適切なエラーメッセージを返す
  handles.init.enable();
  handles.systemStatus.enable();
  handles.search.enable();
  handles.getDocument.enable();
  handles.getOutline.enable();
  handles.indexStatus.enable();
  handles.listRelatedProjects.enable();
  handles.addRelatedProject.enable();
  debugLog('All tools enabled (state check delegated to each tool)');
}

/**
 * メイン処理
 */
async function main() {
  // コマンドライン引数の解析
  const { projectDir } = parseArgs();

  // プロジェクトディレクトリを決定
  const cwd = projectDir || process.cwd();

  // ログリダイレクト設定（console.log/error/warnをファイルに転送）
  const logPath = process.env.SEARCH_DOCS_LOG_PATH
    || path.join(cwd, '.search-docs', 'server.log');
  setupLogRedirect(logPath);

  debugLog(`Working directory: ${cwd}`);

  // システム状態を判定
  const systemState = await detectSystemState(cwd);
  let serviceInstances: ServiceInstances | null = null;

  debugLog('='.repeat(60));
  debugLog(`System state detected: ${systemState.state}`);
  debugLog(`Project root: ${systemState.projectRoot}`);
  debugLog(`Config exists: ${systemState.config ? 'YES' : 'NO'}`);
  debugLog(`Config path: ${systemState.configPath || '(none)'}`);

  // 設定があればin-processでサービスを起動
  if (systemState.state === 'RUNNING' && systemState.config) {
    debugLog('Creating in-process service...');
    try {
      serviceInstances = await createService(systemState.config, systemState.projectRoot, VERSION);
      systemState.service = serviceInstances.service;
      debugLog('✓ In-process service created successfully');
    } catch (error) {
      debugLog(`✗ Service creation failed: ${(error as Error).message}`);
    }
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
        resources: {},
      },
      instructions: [
        'search-docsはプロジェクト内のドキュメントを高速・効率的に検索するシステムです。',
        'システムの設計や背景知識を探したいときや、ドキュメントのメンテナンス時の作業を強力にアシストします。',
        '詳しい使い方や設定はこのMCPサーバーのリソース（resources/list）を参照してください。',
      ].join('\n'),
    }
  );

  // ツールハンドルを保持する変数
  let toolHandles: ToolHandles | null = null;

  // システム状態を再検出する関数
  const refreshSystemState = async () => {
    // 既存サービスを停止
    if (serviceInstances) {
      debugLog('Stopping existing service before refresh...');
      await stopService(serviceInstances);
      serviceInstances = null;
    }

    const newState = await detectSystemState(cwd);
    // systemStateオブジェクトのプロパティを更新
    Object.assign(systemState, newState);

    // 設定があればサービスを再作成
    if (systemState.state === 'RUNNING' && systemState.config) {
      try {
        serviceInstances = await createService(systemState.config, systemState.projectRoot, VERSION);
        systemState.service = serviceInstances.service;
        debugLog('✓ Service recreated after refresh');
      } catch (error) {
        debugLog(`✗ Service recreation failed: ${(error as Error).message}`);
      }
    }

    debugLog(`System state refreshed: ${systemState.state}`);

    // ツールの有効/無効を更新
    if (toolHandles) {
      updateToolAvailability(systemState.state, toolHandles);
    }
  };

  // サーバマネージャーの作成（複数プロジェクト管理用）
  const serverManager = new ServerManager();

  // ツール登録コンテキスト
  const context = { server, systemState, refreshSystemState, serverManager };

  // リソース登録
  registerResources(server);

  // 全ツールを登録
  debugLog('Registering all tools...');
  toolHandles = {
    init: registerInitTool(context),
    systemStatus: registerSystemStatusTool(context),
    search: registerSearchTool(context),
    getDocument: registerGetDocumentTool(context),
    getOutline: registerGetOutlineTool(context),
    indexStatus: registerIndexStatusTool(context),
    listRelatedProjects: registerListRelatedProjectsTool(context),
    addRelatedProject: registerAddRelatedProjectTool(context),
  };

  // 初期状態に応じてツールの有効/無効を設定
  updateToolAvailability(systemState.state, toolHandles);

  // プロセス終了時のクリーンアップ
  const cleanup = async () => {
    debugLog('Cleaning up...');
    if (serviceInstances) {
      await stopService(serviceInstances);
      serviceInstances = null;
    }
  };

  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());

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
