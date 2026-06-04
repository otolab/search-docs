/**
 * システム状態管理
 */

import * as path from 'path';
import { ConfigLoader, type ConfigDeprecation } from '@search-docs/config';
import type { SearchDocsConfig, SearchDocsService } from '@search-docs/types';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { SearchDocsServer, WatcherProcess, EmbeddingServerProcess } from '@search-docs/server';

/**
 * システム状態の種類
 */
export type SystemState = 'NOT_CONFIGURED' | 'RUNNING';

/**
 * システム状態情報
 */
export interface SystemStateInfo {
  /** システム状態 */
  state: SystemState;
  /** 設定情報（設定ファイルが存在する場合） */
  config?: SearchDocsConfig;
  /** 設定ファイルのパス（設定ファイルが存在する場合） */
  configPath?: string;
  /** プロジェクトルート */
  projectRoot: string;
  /** サービスインスタンス（サーバが稼働中の場合） */
  service?: SearchDocsService;
  /** 非推奨設定の警告 */
  deprecations?: ConfigDeprecation[];
}

/**
 * サービスインスタンス群
 */
export interface ServiceInstances {
  service: SearchDocsServer;
  watcherProcess: WatcherProcess;
  dbEngine: DBEngine;
  embeddingServer: EmbeddingServerProcess;
}

/**
 * システム状態を判定
 *
 * @param cwd - カレントワーキングディレクトリ
 * @returns システム状態情報
 */
export async function detectSystemState(cwd: string): Promise<SystemStateInfo> {
  // 設定ファイルの存在確認のみ行う
  // サービスの作成は createService() で行う
  try {
    const result = await ConfigLoader.resolve({
      cwd,
      requireConfig: false, // エラーで終了しない
      traverseUp: false, // 上位ディレクトリを遡らない（テスト時の意図しない設定読み込みを防ぐ）
    });

    // 設定ファイルが見つからない場合（configPath === null）は未設定状態
    // ConfigLoader.resolve()はデフォルト設定を返すが、設定ファイルが存在しない場合は
    // NOT_CONFIGURED状態として扱う
    if (!result.config || result.configPath === null) {
      // 設定ファイルなし
      return {
        state: 'NOT_CONFIGURED',
        projectRoot: cwd,
      };
    }

    // 設定ファイルあり
    return {
      state: 'RUNNING',
      config: result.config,
      configPath: result.configPath ?? undefined,
      projectRoot: result.projectRoot,
      deprecations: result.deprecations.length > 0 ? result.deprecations : undefined,
    };
  } catch (_error) {
    // 設定ファイル読み込みエラー
    return {
      state: 'NOT_CONFIGURED',
      projectRoot: cwd,
    };
  }
}

/**
 * サービスインスタンスを作成
 *
 * @param config - 設定情報
 * @param projectRoot - プロジェクトルート
 * @param version - バージョン情報
 * @returns サービスインスタンス群
 */
export async function createService(
  config: SearchDocsConfig,
  projectRoot: string,
  version: string
): Promise<ServiceInstances> {
  // 1. EmbeddingServerProcess検出・起動
  const embeddingServer = new EmbeddingServerProcess({
    embeddingUrl: process.env.EMBEDDING_URL || config.indexing.embeddingUrl,
    port: 24281,
    runtime: 'onnx',
    modelPath: process.env.SEARCH_DOCS_DOCKER_MODEL_PATH,
    dimension: config.indexing.vectorDimension,
  });
  const embeddingUrl = await embeddingServer.start();

  // 2. FileStorage初期化
  const storage = new FileStorage({
    basePath: path.resolve(projectRoot, config.storage.documentsPath),
  });

  // 3. DBEngine初期化
  const dbEngine = new DBEngine({
    dbPath: path.resolve(projectRoot, config.storage.indexPath),
    embeddingUrl,
    maxBatchTokens: config.worker.maxBatchTokens,
    pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
    memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
    readOnly: false,
  });

  // 4. SearchDocsServer初期化
  const service = new SearchDocsServer(config, storage, dbEngine, version);

  // 5. WatcherProcess初期化・接続
  const watcherProcess = new WatcherProcess(config, storage, dbEngine);
  service.setWatcherProcess(watcherProcess);

  // 6. 起動
  service.start();
  watcherProcess.start();

  return { service, watcherProcess, dbEngine, embeddingServer };
}

/**
 * サービスインスタンスを停止（即座に完了する）
 *
 * WatcherProcess（IndexWorker）のタイマーを停止し、新規処理を防ぐ。
 * 子プロセス（Python worker, Embedding server）にSIGTERMを送信する。
 * 子プロセスは親プロセス終了時にOSが回収するため、終了待ちは不要。
 *
 * FileStorageはatomic write（tmp→rename）のため、書き込み途中でも壊れない。
 * LanceDBはMVCCのため、書き込み途中でも壊れない。
 * Writer mastershipは120秒で自動復旧するため、明示的な解放は不要。
 *
 * @param instances - サービスインスタンス群
 */
export function stopService(instances: ServiceInstances): void {
  // 1. WatcherProcessを停止（タイマー・ワーカー即停止、mastershipは解放しない）
  instances.watcherProcess.shutdown();

  // 2. 読み取り専用サービスを停止
  instances.service.stop();

  // 3. DBEngineを切断（Python workerをkill）
  instances.dbEngine.disconnect();

  // 4. EmbeddingServerを停止（子プロセスにSIGTERM）
  instances.embeddingServer.shutdown();
}

/**
 * システム状態に応じたエラーメッセージを生成
 *
 * @param state - システム状態
 * @param action - 実行しようとしたアクション名
 * @returns エラーメッセージ
 */
export function getStateErrorMessage(state: SystemState, action: string, relatedProjectNames?: string[]): string {
  switch (state) {
    case 'NOT_CONFIGURED': {
      let message =
        `ローカルプロジェクトが設定されていないため、${action}を実行できません。\n\n` +
        '利用可能なオプション:\n' +
        '  - ローカルプロジェクトを設定: init\n' +
        '  - 関連プロジェクトを追加して検索: add_related_project\n' +
        '  - 詳しくはMCPリソース「search-docsをはじめる」を参照\n';

      if (relatedProjectNames && relatedProjectNames.length > 0) {
        message += `\n利用可能な関連プロジェクト: ${relatedProjectNames.join(', ')}\n`;
        message += '関連プロジェクトを検索するには project パラメータを指定してください。\n';
      }

      return message;
    }

    case 'RUNNING':
      // サーバ稼働中は通常エラーにならないが、念のため
      return `${action}を実行できません。予期しないエラーが発生しました。`;
  }
}
