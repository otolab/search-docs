#!/usr/bin/env node

/**
 * SearchDocs HTTP JSON-RPCサーバ エントリポイント
 */

import * as path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { ConfigLoader } from '@search-docs/config';
import type { PidFileContent } from '@search-docs/types';
import { SearchDocsServer, JsonRpcServer, WatcherProcess, EmbeddingServerProcess } from '../index.js';
import {
  writePidFile,
  deletePidFile,
  readPidFile,
  isProcessAlive,
} from '../utils/pid.js';
import { setupLogRedirect } from '../utils/log-redirect.js';

export async function main(): Promise<void> {
  let embeddingServer: EmbeddingServerProcess | null = null;
  let watcherProcess: WatcherProcess | null = null;
  let jsonRpcServer: JsonRpcServer | null = null;
  let projectRootForCleanup: string | null = null;
  let pidFileWritten = false;
  let cleanupPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let startupComplete = false;

  const ensureStartupNotInterrupted = () => {
    if (shutdownRequested) {
      throw new Error('Server startup was interrupted by a shutdown signal');
    }
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };

      if (watcherProcess) await attempt(() => watcherProcess!.stop());
      if (pidFileWritten && projectRootForCleanup) {
        await attempt(() => deletePidFile(projectRootForCleanup!));
        pidFileWritten = false;
      }
      if (jsonRpcServer) await attempt(() => jsonRpcServer!.stop());
      if (embeddingServer) await attempt(() => embeddingServer!.stop());

      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more server resources failed to stop cleanly');
      }
    })();
    return cleanupPromise;
  };

  const onShutdownSignal = () => {
    shutdownRequested = true;
    if (!startupComplete) {
      embeddingServer?.shutdown();
      return;
    }
    console.log('\nShutting down...');
    void cleanup()
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error('Failed to shut down cleanly:', error);
        process.exit(1);
      });
  };
  process.once('SIGINT', onShutdownSignal);
  process.once('SIGTERM', onShutdownSignal);

  try {
    // 設定読み込みとプロジェクトルート決定
    const { config, configPath, projectRoot } = await ConfigLoader.resolve();
    ensureStartupNotInterrupted();
    projectRootForCleanup = projectRoot;

    // ログリダイレクト設定
    const logPath = process.env.SEARCH_DOCS_LOG_PATH
      || path.join(projectRoot, '.search-docs', 'server.log');
    setupLogRedirect(logPath);

    console.log(`Loading config from: ${configPath || 'default config'}`);

    // Docker環境での設定上書き（モデル・次元数）
    const dockerEmbeddingModel = process.env.SEARCH_DOCS_DOCKER_EMBEDDING_MODEL;
    const dockerVectorDimension = process.env.SEARCH_DOCS_DOCKER_VECTOR_DIMENSION;
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

    // Embeddingサーバの検出・起動
    const localEmbeddingServer = new EmbeddingServerProcess({
      embeddingUrl: process.env.EMBEDDING_URL || config.indexing.embeddingUrl,
      port: 24281,
      runtime: 'onnx',
      modelPath: process.env.SEARCH_DOCS_DOCKER_MODEL_PATH,
      dimension: config.indexing.vectorDimension,
    });
    embeddingServer = localEmbeddingServer;
    const embeddingUrl = await localEmbeddingServer.start();
    ensureStartupNotInterrupted();

    // 1. 既存PIDファイルチェック
    const existingPid = await readPidFile(projectRoot);
    ensureStartupNotInterrupted();
    if (existingPid && existingPid.pid !== process.pid) {
      if (isProcessAlive(existingPid.pid)) {
        // PIDが生きていても、別プロセス(Docker再起動時等)の可能性がある
        // ポートで実際にサーバが応答するか確認
        let serverResponding = false;
        try {
          const res = await fetch(`http://localhost:${existingPid.port}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          serverResponding = res.ok;
        } catch {
          // 応答なし
        }
        ensureStartupNotInterrupted();

        if (serverResponding) {
          throw new Error(
            `Server is already running for this project.\n` +
              `  PID: ${existingPid.pid}\n` +
              `  Port: ${existingPid.port}\n` +
              `  Started: ${existingPid.startedAt}\n` +
              `\n` +
              `To stop the server, kill the process or use: search-docs server stop`
          );
        }
      }
      // PIDが死んでいる or ポート応答なし → stale PIDファイル
      console.log(`Cleaning up stale PID file (previous PID: ${existingPid.pid})`);
      await deletePidFile(projectRoot);
      ensureStartupNotInterrupted();
    }

    // 2. PIDファイル作成
    // バージョン情報を取得
    const packageJsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };

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

    pidFileWritten = true;
    await writePidFile(pidFileContent);
    ensureStartupNotInterrupted();
    console.log(`PID file created (PID: ${process.pid})`);

    // ストレージ初期化
    const storage = new FileStorage({
      basePath: path.resolve(projectRoot, config.storage.documentsPath),
    });

    // DBエンジン初期化
    const dbEngine = new DBEngine({
      dbPath: path.resolve(projectRoot, config.storage.indexPath),
      embeddingUrl,
      maxBatchTokens: config.worker.maxBatchTokens,
      pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
      memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
      readOnly: false,
    });

    // SearchDocsサーバ初期化
    const searchDocsServer = new SearchDocsServer(config, storage, dbEngine, packageJson.version);

    // Docker環境では全インターフェースでリッスン（コンテナ外からアクセス可能にする）
    const serverHost = process.env.IS_DOCKER === 'true' ? '0.0.0.0' : config.server.host;

    // JSON-RPCサーバ初期化
    const localJsonRpcServer = new JsonRpcServer(
      searchDocsServer,
      serverHost,
      config.server.port
    );
    jsonRpcServer = localJsonRpcServer;

    // WatcherProcess 生成・接続
    const localWatcherProcess = new WatcherProcess(config, storage, dbEngine);
    watcherProcess = localWatcherProcess;
    searchDocsServer.setWatcherProcess(localWatcherProcess);

    // サーバ起動
    await localJsonRpcServer.start();
    ensureStartupNotInterrupted();

    // WatcherProcess 起動（JSON-RPC サーバの後に起動）
    await localWatcherProcess.start();
    ensureStartupNotInterrupted();
    startupComplete = true;
    console.log('[Server] Watcher process started (file watching + indexing enabled)');

    console.log(`Server started successfully`);
    console.log(`  - Project: ${config.project.name}`);
    console.log(`  - Root: ${projectRoot}`);
    console.log(`  - RPC endpoint: http://${config.server.host}:${config.server.port}/rpc`);
    console.log(`  - Mode: read-write (watcher enabled)`);
  } catch (error) {
    if (!shutdownRequested) {
      console.error('Failed to start server:', error);
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error('Failed to clean up after server startup failure:', cleanupError);
    }
    process.removeListener('SIGINT', onShutdownSignal);
    process.removeListener('SIGTERM', onShutdownSignal);
    process.exitCode = shutdownRequested ? 0 : 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().then(() => {
    if (process.exitCode !== undefined) {
      process.exit(process.exitCode);
    }
  });
}
