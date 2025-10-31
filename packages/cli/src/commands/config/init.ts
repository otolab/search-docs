/**
 * config init コマンド
 * 設定ファイルを生成する
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SearchDocsConfig } from '@search-docs/types';

export interface ConfigInitOptions {
  /** ポート番号（指定しない場合はランダム） */
  port?: number;
  /** プロジェクトルート（デフォルト: cwd） */
  projectRoot?: string;
  /** 既存ファイルを上書き */
  force?: boolean;
  /** カレントワーキングディレクトリ（テスト用、デフォルト: process.cwd()） */
  cwd?: string;
}

/**
 * ランダムなポート番号を生成
 * エフェメラルポート範囲（49152-65535）からランダムに選択
 */
function generateRandomPort(): number {
  const MIN_PORT = 49152;
  const MAX_PORT = 65535;
  return Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
}

/**
 * デフォルト設定オブジェクトを生成
 */
function createDefaultConfig(options: {
  port: number;
  projectRoot: string;
}): SearchDocsConfig {
  return {
    version: '1.0',
    project: {
      name: path.basename(options.projectRoot),
      root: '.',
    },
    files: {
      include: [
        '**/*.md',
        'docs/**/*.txt',
      ],
      exclude: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
      ],
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
      port: options.port,
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
}

/**
 * config init コマンドを実行
 */
export async function initConfig(options: ConfigInitOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const projectRoot = options.projectRoot || cwd;
  const port = options.port || generateRandomPort();
  const configPath = path.join(cwd, '.search-docs.json');

  console.log('Initializing search-docs configuration...\n');

  // 既存ファイルチェック
  try {
    await fs.access(configPath);

    if (!options.force) {
      throw new Error(
        `Configuration file already exists: ${configPath}\n` +
        'Use --force to overwrite the existing file.'
      );
    }

    console.log('⚠️  Overwriting existing configuration file...\n');
  } catch (error) {
    // ファイルが存在しない場合は正常（続行）
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // 設定オブジェクト生成
  const config = createDefaultConfig({ port, projectRoot });

  // ファイル書き込み
  const configContent = JSON.stringify(config, null, 2) + '\n';
  await fs.writeFile(configPath, configContent, 'utf-8');

  console.log('✅ Configuration file created successfully!\n');
  console.log(`📄 File: ${configPath}`);
  console.log(`🚀 Project: ${config.project.name}`);
  console.log(`🔌 Port: ${config.server.port}`);
  console.log(`📁 Root: ${projectRoot}\n`);
  console.log('Next steps:');
  console.log('  1. Review and customize .search-docs.json');
  console.log('  2. Start the server: search-docs server start');
  console.log('  3. Search documents: search-docs search "query"\n');
}
