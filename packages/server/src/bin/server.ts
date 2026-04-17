#!/usr/bin/env node

/**
 * SearchDocs HTTP JSON-RPCサーバ エントリポイント
 */

import * as path from 'path';
import { readFileSync } from 'fs';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { ConfigLoader, type PidFileContent } from '@search-docs/types';
import { SearchDocsServer, JsonRpcServer, WatcherProcess } from '../index.js';
import {
  writePidFile,
  deletePidFile,
  readPidFile,
  isProcessAlive,
} from '../utils/pid.js';
import { setupLogRedirect } from '../utils/log-redirect.js';

async function main() {
  try {
    // 設定読み込みとプロジェクトルート決定
    const { config, configPath, projectRoot } = await ConfigLoader.resolve();

    // ログリダイレクト設定
    const logPath = process.env.SEARCH_DOCS_LOG_PATH
      || path.join(projectRoot, '.search-docs', 'server.log');
    setupLogRedirect(logPath);

    console.log(`Loading config from: ${configPath || 'default config'}`);

    // 環境変数によるembeddingUrl上書き（テスト環境・Docker環境共通）
    const envEmbeddingUrl = process.env.EMBEDDING_URL;
    if (envEmbeddingUrl) {
      config.indexing.embeddingUrl = envEmbeddingUrl;
    }

    // Docker環境での設定固定ルール
    const dockerEmbeddingUrl = process.env.SEARCH_DOCS_DOCKER_EMBEDDING_URL;
    const dockerEmbeddingModel = process.env.SEARCH_DOCS_DOCKER_EMBEDDING_MODEL;
    const dockerVectorDimension = process.env.SEARCH_DOCS_DOCKER_VECTOR_DIMENSION;
    // EMBEDDING_URL が明示設定されている場合はそちらを優先（entrypoint.shの検出結果）
    if (dockerEmbeddingUrl && !envEmbeddingUrl) {
      if (config.indexing.embeddingUrl && config.indexing.embeddingUrl !== dockerEmbeddingUrl) {
        console.warn(
          `[Docker] Config embeddingUrl "${config.indexing.embeddingUrl}" ` +
          `overridden to "${dockerEmbeddingUrl}" (container-local embedding server)`
        );
      }
      config.indexing.embeddingUrl = dockerEmbeddingUrl;
    }
    if (dockerEmbeddingModel) {
      if (config.indexing.embeddingModel !== dockerEmbeddingModel) {
        console.warn(
          `[Docker] Config embeddingModel "${config.indexing.embeddingModel}" ` +
          `overridden to "${dockerEmbeddingModel}" (image-baked model)`
        );
      }
      config.indexing.embeddingModel = dockerEmbeddingModel;
    }
    if (dockerVectorDimension) {
      const dim = parseInt(dockerVectorDimension, 10);
      if (!isNaN(dim) && config.indexing.vectorDimension !== dim) {
        console.warn(
          `[Docker] Config vectorDimension ${config.indexing.vectorDimension} ` +
          `overridden to ${dim} (image-baked model)`
        );
        config.indexing.vectorDimension = dim;
      }
    }

    // Read-onlyモード判定（環境変数 or CLI引数）
    const isReadOnly = process.env.READ_ONLY === 'true' || process.argv.includes('--read-only');
    if (isReadOnly) {
      config.server.readOnly = true;
      config.watcher.enabled = false;
      config.worker.enabled = false;
      console.log('[ReadOnly] Running in read-only mode (watcher/worker disabled)');
    }

    // 1. 既存PIDファイルチェック（read-onlyモードではスキップ）
    if (!config.server.readOnly) {
      const existingPid = await readPidFile(projectRoot);
      if (existingPid && existingPid.pid !== process.pid && isProcessAlive(existingPid.pid)) {
        throw new Error(
          `Server is already running for this project.\n` +
            `  PID: ${existingPid.pid}\n` +
            `  Port: ${existingPid.port}\n` +
            `  Started: ${existingPid.startedAt}\n` +
            `\n` +
            `To stop the server, kill the process or use: search-docs server stop`
        );
      }

      // 古いPIDファイルがあれば削除（自分自身のPIDでない場合のみ）
      if (existingPid && existingPid.pid !== process.pid) {
        console.log(`Cleaning up stale PID file (previous PID: ${existingPid.pid})`);
        await deletePidFile(projectRoot);
      }
    }

    // 2. PIDファイル作成（read-onlyモードではスキップ）
    // バージョン情報を取得
    const packageJsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };

    if (!config.server.readOnly) {
      const pidFileContent: PidFileContent = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
        projectName: config.project.name,
        host: config.server.host,
        port: config.server.port,
        configPath,
        version: packageJson.version,
        nodeVersion: process.version,
      };

      await writePidFile(pidFileContent);
      console.log(`PID file created (PID: ${process.pid})`);
    }

    // ストレージ初期化
    const storage = new FileStorage({
      basePath: path.resolve(projectRoot, config.storage.documentsPath),
    });

    // DBエンジン初期化
    const dbEngine = new DBEngine({
      dbPath: path.resolve(projectRoot, config.storage.indexPath),
      embeddingUrl: config.indexing.embeddingUrl,
      maxBatchTokens: config.worker.maxBatchTokens,
      pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
      memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
      readOnly: config.server.readOnly,
    });

    // SearchDocsサーバ初期化
    const searchDocsServer = new SearchDocsServer(config, storage, dbEngine, packageJson.version);

    // Docker環境ではIPv4/IPv6両方でリッスン（localhostだとIPv6のみになる場合がある）
    const serverHost = process.env.SEARCH_DOCS_DOCKER_EMBEDDING_URL ? '0.0.0.0' : config.server.host;

    // JSON-RPCサーバ初期化
    const jsonRpcServer = new JsonRpcServer(
      searchDocsServer,
      serverHost,
      config.server.port
    );

    // read-only でない場合は WatcherProcess も起動
    let watcherProcess: WatcherProcess | null = null;
    if (!config.server.readOnly) {
      watcherProcess = new WatcherProcess(config, storage, dbEngine);
    }

    // シグナルハンドラ（PIDファイル削除を追加）
    const shutdown = async () => {
      console.log('\nShutting down...');

      if (watcherProcess) {
        await watcherProcess.stop();
      }

      // PIDファイル削除（read-onlyモードでは作成していないのでスキップ）
      if (!config.server.readOnly) {
        await deletePidFile(projectRoot);
        console.log('PID file removed');
      }

      await jsonRpcServer.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // サーバ起動
    await jsonRpcServer.start();

    // WatcherProcess 起動（JSON-RPC サーバの後に起動）
    if (watcherProcess) {
      await watcherProcess.start();
      console.log('[Server] Watcher process started (file watching + indexing enabled)');
    }

    console.log(`Server started successfully`);
    console.log(`  - Project: ${config.project.name}`);
    console.log(`  - Root: ${projectRoot}`);
    console.log(`  - RPC endpoint: http://${config.server.host}:${config.server.port}/rpc`);
    if (!config.server.readOnly) {
      console.log(`  - Mode: read-write (watcher enabled)`);
    } else {
      console.log(`  - Mode: read-only`);
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
