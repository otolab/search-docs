#!/usr/bin/env node
/**
 * search-docs CLI
 */

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { executeSearch, type SearchCommandOptions } from './commands/search.js';
import {
  executeServerStart,
  type ServerStartOptions,
} from './commands/server/start.js';
import {
  executeServerStop,
  type ServerStopOptions,
} from './commands/server/stop.js';
import {
  executeServerStatus,
  type ServerStatusOptions,
} from './commands/server/status.js';
import {
  executeServerRestart,
  type ServerRestartOptions,
} from './commands/server/restart.js';

// package.jsonからバージョンを読み込む
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
  version: string;
};

/**
 * グローバル設定（preSubcommandフックで設定）
 */
let globalConfigPath: string | undefined;

const program = new Command();

program
  .name('search-docs')
  .description('search-docs コマンドラインツール')
  .version(packageJson.version)
  .addOption(
    new Option('-c, --config <path>', '設定ファイルのパス')
      .env('SEARCH_DOCS_CONFIG')
  )
  .hook('preSubcommand', (thisCommand) => {
    const opts = thisCommand.opts<{ config?: string }>();
    globalConfigPath = opts.config;
  });

// server コマンド
const serverCmd = program
  .command('server')
  .description('サーバの起動・停止・ステータス確認');

serverCmd
  .command('start')
  .description('サーバを起動（デフォルト: バックグラウンド）')
  .option('--port <port>', 'ポート番号')
  .option('-f, --foreground', 'フォアグラウンドで起動（開発時）')
  .option('--log <path>', 'ログファイルのパス')
  .action((options: ServerStartOptions) => {
    void executeServerStart({ ...options, config: globalConfigPath });
  });

serverCmd
  .command('stop')
  .description('サーバを停止')
  .action((options: ServerStopOptions) => {
    void executeServerStop({ ...options, config: globalConfigPath });
  });

serverCmd
  .command('status')
  .description('サーバのステータスを確認')
  .action((options: ServerStatusOptions) => {
    void executeServerStatus({ ...options, config: globalConfigPath });
  });

serverCmd
  .command('restart')
  .description('サーバを再起動（デフォルト: バックグラウンド）')
  .option('--port <port>', 'ポート番号')
  .option('-f, --foreground', 'フォアグラウンドで起動（開発時）')
  .option('--log <path>', 'ログファイルのパス')
  .action((options: ServerRestartOptions) => {
    void executeServerRestart({ ...options, config: globalConfigPath });
  });

// search コマンド
program
  .command('search')
  .description('ドキュメントを検索')
  .argument('<query>', '検索クエリ')
  .option('--limit <n>', '最大結果数', '10')
  .option('--depth <depths...>', '深度フィルタ')
  .option('--format <format>', '出力形式 (text, json)', 'text')
  .option('--clean-only', 'Dirtyセクションを除外')
  .option('--server <url>', 'サーバURL')
  .action((query: string, options: SearchCommandOptions) => {
    void executeSearch(query, { ...options, config: globalConfigPath });
  });

// index コマンド
const indexCmd = program
  .command('index')
  .description('インデックス管理');

indexCmd
  .command('rebuild')
  .description('インデックスを再構築')
  .argument('[paths...]', '再構築するファイルのパス')
  .option('--force', '強制的に再インデックス')
  .option('--server <url>', 'サーバURL')
  .action(async (paths: string[], options: { force?: boolean; server?: string }) => {
    const { executeIndexRebuild } = await import('./commands/index/rebuild.js');
    await executeIndexRebuild({ paths, ...options, config: globalConfigPath });
  });

indexCmd
  .command('status')
  .description('インデックスのステータスを確認')
  .option('--server <url>', 'サーバURL')
  .option('--format <format>', '出力形式 (text, json)', 'text')
  .action(async (options: { server?: string; format?: 'text' | 'json' }) => {
    const { executeIndexStatus } = await import('./commands/index/status.js');
    await executeIndexStatus({ ...options, config: globalConfigPath });
  });

// config コマンド
const configCmd = program
  .command('config')
  .description('設定管理');

configCmd
  .command('init')
  .description('設定ファイルを初期化')
  .option('--interactive, -i', '対話的に設定を作成')
  .option('--force, -f', '既存ファイルを上書き')
  .action(() => {
    console.log('config init: 未実装');
  });


// コマンドラインを解析
program.parse(process.argv);
