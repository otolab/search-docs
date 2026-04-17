#!/usr/bin/env node

/**
 * SearchDocs Watcher プロセス エントリポイント
 * ファイル監視 + インデックス更新を担当する独立プロセス
 */

import * as path from 'path';
import { mkdirSync } from 'fs';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { ConfigLoader } from '@search-docs/types';
import { WatcherProcess } from '../watcher/watcher-process.js';
import { RotatingWriteStream } from '../utils/rotating-log.js';

/**
 * ログ出力をRotatingWriteStreamにリダイレクト
 */
function setupLogRedirect(logPath: string): void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = new RotatingWriteStream(logPath);

  const formatMessage = (args: unknown[]): string => {
    const timestamp = new Date().toISOString();
    const message = args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a, null, 2)
    ).join(' ');
    return `[${timestamp}] ${message}\n`;
  };

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => { logStream.write(formatMessage(args)); };
  console.error = (...args: unknown[]) => { logStream.write(formatMessage(['[ERROR]', ...args])); };
  console.warn = (...args: unknown[]) => { logStream.write(formatMessage(['[WARN]', ...args])); };

  // フォアグラウンドモードではコンソールにも出力
  if (process.stdout.isTTY) {
    console.log = (...args: unknown[]) => { logStream.write(formatMessage(args)); originalLog(...args); };
    console.error = (...args: unknown[]) => { logStream.write(formatMessage(['[ERROR]', ...args])); originalError(...args); };
    console.warn = (...args: unknown[]) => { logStream.write(formatMessage(['[WARN]', ...args])); originalWarn(...args); };
  }
}

async function main() {
  try {
    // 設定読み込みとプロジェクトルート決定
    const { config, configPath, projectRoot } = await ConfigLoader.resolve();

    // ログリダイレクト設定
    const logPath = process.env.SEARCH_DOCS_LOG_PATH
      || path.join(projectRoot, '.search-docs', 'watcher.log');
    setupLogRedirect(logPath);

    console.log(`[Watcher] Loading config from: ${configPath || 'default config'}`);

    // 環境変数によるembeddingUrl上書き
    const envEmbeddingUrl = process.env.EMBEDDING_URL;
    if (envEmbeddingUrl) {
      config.indexing.embeddingUrl = envEmbeddingUrl;
    }

    // Docker環境での設定固定ルール
    const dockerEmbeddingUrl = process.env.SEARCH_DOCS_DOCKER_EMBEDDING_URL;
    const dockerEmbeddingModel = process.env.SEARCH_DOCS_DOCKER_EMBEDDING_MODEL;
    const dockerVectorDimension = process.env.SEARCH_DOCS_DOCKER_VECTOR_DIMENSION;
    if (dockerEmbeddingUrl && !envEmbeddingUrl) {
      config.indexing.embeddingUrl = dockerEmbeddingUrl;
    }
    if (dockerEmbeddingModel) {
      config.indexing.embeddingModel = dockerEmbeddingModel;
    }
    if (dockerVectorDimension) {
      const dim = parseInt(dockerVectorDimension, 10);
      if (!isNaN(dim)) {
        config.indexing.vectorDimension = dim;
      }
    }

    // Watcher は常に read-write モード（watcher/worker 有効化を強制）
    config.watcher.enabled = true;
    config.worker.enabled = true;

    // ストレージ初期化
    const storage = new FileStorage({
      basePath: path.resolve(projectRoot, config.storage.documentsPath),
    });

    // DBエンジン初期化（read-write モード）
    const dbEngine = new DBEngine({
      dbPath: path.resolve(projectRoot, config.storage.indexPath),
      embeddingUrl: config.indexing.embeddingUrl,
      maxBatchTokens: config.worker.maxBatchTokens,
      pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
      memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
      readOnly: false,
    });

    // WatcherProcess 初期化
    const watcherProcess = new WatcherProcess(config, storage, dbEngine);

    // シグナルハンドラ
    const shutdown = async () => {
      console.log('[Watcher] Shutting down...');
      await watcherProcess.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Watcher 起動
    await watcherProcess.start();
    console.log(`[Watcher] Started successfully`);
    console.log(`  - Project: ${config.project.name}`);
    console.log(`  - Root: ${projectRoot}`);
  } catch (error) {
    console.error('[Watcher] Failed to start:', error);
    process.exit(1);
  }
}

main();
