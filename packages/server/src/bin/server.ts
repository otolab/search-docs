#!/usr/bin/env node

/**
 * SearchDocs HTTP JSON-RPCサーバ エントリポイント
 */

import * as path from 'path';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { SearchDocsServer, JsonRpcServer, ConfigLoader } from '../index.js';

async function main() {
  try {
    // 設定読み込み
    const configPath = process.env.SEARCH_DOCS_CONFIG || path.join(process.cwd(), 'search-docs.json');
    console.log(`Loading config from: ${configPath}`);
    const config = await ConfigLoader.load(configPath);

    // プロジェクトルートを絶対パスに解決
    const projectRoot = path.isAbsolute(config.project.root)
      ? config.project.root
      : path.resolve(process.cwd(), config.project.root);

    // ストレージ初期化
    const storage = new FileStorage({
      basePath: path.resolve(projectRoot, config.storage.documentsPath),
    });

    // DBエンジン初期化
    const dbEngine = new DBEngine({
      dbPath: path.resolve(projectRoot, config.storage.indexPath),
      embeddingModel: config.indexing.embeddingModel,
    });

    // SearchDocsサーバ初期化
    const searchDocsServer = new SearchDocsServer(config, storage, dbEngine);

    // JSON-RPCサーバ初期化
    const jsonRpcServer = new JsonRpcServer(
      searchDocsServer,
      config.server.host,
      config.server.port
    );

    // シグナルハンドラ
    const shutdown = async () => {
      console.log('\nShutting down...');
      await jsonRpcServer.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // サーバ起動
    await jsonRpcServer.start();
    console.log(`Server started successfully`);
    console.log(`  - Project: ${config.project.name}`);
    console.log(`  - Root: ${config.project.root}`);
    console.log(`  - RPC endpoint: http://${config.server.host}:${config.server.port}/rpc`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
