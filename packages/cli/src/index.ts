#!/usr/bin/env node
/**
 * search-docs CLI
 */

import { Command } from 'commander';
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

const program = new Command();

program
  .name('search-docs')
  .description('search-docs コマンドラインツール')
  .version(packageJson.version);

// server コマンド
const serverCmd = program
  .command('server')
  .description('サーバの起動・停止・ステータス確認');

serverCmd
  .command('start')
  .description('サーバを起動')
  .option('--config <path>', '設定ファイルのパス')
  .option('--port <port>', 'ポート番号')
  .option('-d, --daemon', 'バックグラウンドで起動')
  .option('--log <path>', 'ログファイルのパス')
  .action((options: ServerStartOptions) => {
    void executeServerStart(options);
  });

serverCmd
  .command('stop')
  .description('サーバを停止')
  .option('--config <path>', '設定ファイルのパス')
  .action((options: ServerStopOptions) => {
    void executeServerStop(options);
  });

serverCmd
  .command('status')
  .description('サーバのステータスを確認')
  .option('--config <path>', '設定ファイルのパス')
  .action((options: ServerStatusOptions) => {
    void executeServerStatus(options);
  });

serverCmd
  .command('restart')
  .description('サーバを再起動')
  .option('--config <path>', '設定ファイルのパス')
  .option('--port <port>', 'ポート番号')
  .option('-d, --daemon', 'バックグラウンドで起動')
  .option('--log <path>', 'ログファイルのパス')
  .action((options: ServerRestartOptions) => {
    void executeServerRestart(options);
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
  .option('--server <url>', 'サーバURL', 'http://localhost:24280')
  .action((query: string, options: SearchCommandOptions) => {
    void executeSearch(query, options);
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
  .option('--server <url>', 'サーバURL', 'http://localhost:24280')
  .action(async (paths: string[], options: { force?: boolean; server?: string }) => {
    const { executeIndexRebuild } = await import('./commands/index/rebuild.js');
    await executeIndexRebuild({ paths, ...options });
  });

indexCmd
  .command('status')
  .description('インデックスのステータスを確認')
  .option('--server <url>', 'サーバURL', 'http://localhost:24280')
  .action(() => {
    console.log('index status: 未実装');
  });

indexCmd
  .command('clean')
  .description('Dirtyセクションをクリーン')
  .option('--server <url>', 'サーバURL', 'http://localhost:24280')
  .action(() => {
    console.log('index clean: 未実装');
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

configCmd
  .command('validate')
  .description('設定ファイルを検証')
  .action(() => {
    console.log('config validate: 未実装');
  });

configCmd
  .command('show')
  .description('設定内容を表示')
  .action(() => {
    console.log('config show: 未実装');
  });

// コマンドラインを解析
program.parse(process.argv);
