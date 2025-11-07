#!/usr/bin/env node

/**
 * SearchDocs HTTP JSON-RPCサーバ エントリポイント
 */

import * as path from 'path';
import { readFileSync } from 'fs';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { ConfigLoader, type PidFileContent } from '@search-docs/types';
import { SearchDocsServer, JsonRpcServer } from '../index.js';
import {
  writePidFile,
  deletePidFile,
  readPidFile,
  isProcessAlive,
} from '../utils/pid.js';

async function main() {
  try {
    // 設定読み込みとプロジェクトルート決定
    const { config, configPath, projectRoot } = await ConfigLoader.resolve();
    console.log(`Loading config from: ${configPath || 'default config'}`);

    // 1. 既存PIDファイルチェック
    const existingPid = await readPidFile(projectRoot);
    if (existingPid && isProcessAlive(existingPid.pid)) {
      throw new Error(
        `Server is already running for this project.\n` +
          `  PID: ${existingPid.pid}\n` +
          `  Port: ${existingPid.port}\n` +
          `  Started: ${existingPid.startedAt}\n` +
          `\n` +
          `To stop the server, kill the process or use: search-docs server stop`
      );
    }

    // 古いPIDファイルがあれば削除
    if (existingPid) {
      console.log(`Cleaning up stale PID file (previous PID: ${existingPid.pid})`);
      await deletePidFile(projectRoot);
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

    await writePidFile(pidFileContent);
    console.log(`PID file created (PID: ${process.pid})`);

    // ストレージ初期化
    const storage = new FileStorage({
      basePath: path.resolve(projectRoot, config.storage.documentsPath),
    });

    // DBエンジン初期化
    const dbEngine = new DBEngine({
      dbPath: path.resolve(projectRoot, config.storage.indexPath),
      embeddingModel: config.indexing.embeddingModel,
      pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
      memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
    });

    // SearchDocsサーバ初期化
    const searchDocsServer = new SearchDocsServer(config, storage, dbEngine);

    // JSON-RPCサーバ初期化
    const jsonRpcServer = new JsonRpcServer(
      searchDocsServer,
      config.server.host,
      config.server.port
    );

    // シグナルハンドラ（PIDファイル削除を追加）
    const shutdown = async () => {
      console.log('\nShutting down...');

      // PIDファイル削除
      await deletePidFile(projectRoot);
      console.log('PID file removed');

      await jsonRpcServer.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // サーバ起動
    await jsonRpcServer.start();
    console.log(`Server started successfully`);
    console.log(`  - Project: ${config.project.name}`);
    console.log(`  - Root: ${projectRoot}`);
    console.log(`  - RPC endpoint: http://${config.server.host}:${config.server.port}/rpc`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
