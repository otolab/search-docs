/**
 * システム状態管理
 */

import * as path from 'path';
import { mkdir } from 'node:fs/promises';
import { ConfigLoader, type ConfigDeprecation } from '@search-docs/config';
import type { SearchDocsConfig, SearchDocsService } from '@search-docs/types';
import { FileStorage } from '@search-docs/storage';
import { DBEngine, strictMaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { SearchDocsServer, WatcherProcess, EmbeddingServerProcess, prepareEmbeddingOptions, diagnoseStrictConfig, StrictSafetyError } from '@search-docs/server';

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
  releaseStorageRegistration?: (() => Promise<void>) | null;
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
  let maintenanceLock: Awaited<ReturnType<typeof strictMaintenanceLock>>;
  let releaseStorageRegistration: () => Promise<void>;
  try {
    maintenanceLock = await strictMaintenanceLock({
      projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath, files: config.files,
    });
    releaseStorageRegistration = await maintenanceLock.acquireShared();
  } catch (error) {
    throw new StrictSafetyError(`保存先の安全性を確認できません: ${String(error)}`);
  }
  // DB または文書を使い始める前の失敗なら登録を安全に解放できる。
  let storageStarted = false;
  let service: SearchDocsServer | undefined;
  let watcherProcess: WatcherProcess | undefined;
  let admission: (() => Promise<void>) | undefined;
  let startupEngine: DBEngine | undefined;
  let checkingSafety = true;
  let diagnosticStopUnconfirmed = false;
  // 1. EmbeddingServerProcess検出・起動
  const embeddingServer = new EmbeddingServerProcess({
    embedding: config.indexing.embedding,
    embeddingUrl: process.env.EMBEDDING_URL || config.indexing.embeddingUrl,
    requireEmbeddingUrl: Boolean(process.env.EMBEDDING_URL),
    port: 24281,
    runtime: 'onnx',
    modelPath: process.env.SEARCH_DOCS_DOCKER_MODEL_PATH,
    dimension: config.indexing.vectorDimension,
  });
  try {
    admission = await maintenanceLock.acquireAdmission();
    await diagnoseStrictConfig(config);
    await mkdir(path.resolve(projectRoot, config.storage.documentsPath), { recursive: true });
    checkingSafety = false;
    const embeddingUrl = await embeddingServer.start();

    // 2. FileStorage初期化
    const storage = new FileStorage({
      basePath: path.resolve(projectRoot, config.storage.documentsPath),
    });

    // 3. DBEngine初期化
    const dbEngine = new DBEngine({
      dbPath: path.resolve(projectRoot, config.storage.indexPath),
      embeddingUrl,
      embeddingDimension: config.indexing.vectorDimension,
      embeddingOptions: prepareEmbeddingOptions(config.indexing.embedding),
      embeddingProvider: config.indexing.embedding?.provider,
      embeddingModel: config.indexing.embedding && 'model' in config.indexing.embedding ? config.indexing.embedding.model : undefined,
      maxBatchTokens: config.worker.maxBatchTokens,
      pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
      memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
      readOnly: false,
    });
    startupEngine = dbEngine;
    await dbEngine.connect();
    await admission();
    admission = undefined;

    // 4. SearchDocsServer初期化
    service = new SearchDocsServer(config, storage, dbEngine, version);

    // 5. WatcherProcess初期化・接続
    watcherProcess = new WatcherProcess(config, storage, dbEngine, async () => {
      const releaseAdmission = await maintenanceLock.acquireAdmission();
      try { await diagnoseStrictConfig(config); }
      catch (error) { if (error instanceof UnconfirmedProcessStopError) diagnosticStopUnconfirmed = true; throw error; }
      finally { if (!diagnosticStopUnconfirmed) await releaseAdmission(); }
    }, error => {
      console.error('安全性を確認できないためサービスを停止します:', error);
      void stopService({
        service: service!,
        watcherProcess: watcherProcess!,
        dbEngine,
        embeddingServer,
        releaseStorageRegistration: diagnosticStopUnconfirmed ? undefined : releaseStorageRegistration,
      }).catch(stopError => console.error('停止に失敗しました:', stopError));
    });
    service.setWatcherProcess(watcherProcess);

    // 6. 起動
    storageStarted = true;
    service.start();
    watcherProcess.start();

    return { service, watcherProcess, dbEngine, embeddingServer, releaseStorageRegistration: async () => {
      if (!diagnosticStopUnconfirmed) await releaseStorageRegistration();
    } };
  } catch (error) {
    if (error instanceof UnconfirmedProcessStopError) diagnosticStopUnconfirmed = true;
    let stopped = !storageStarted && !diagnosticStopUnconfirmed;
    if (!storageStarted && startupEngine) {
      try { await startupEngine.disconnect(); } catch { stopped = false; }
    }
    if (stopped) await admission?.();
    if (storageStarted) {
      try {
        if (watcherProcess) await watcherProcess.stop();
        if (service) await service.stop();
        stopped = true;
      } catch (stopError) {
        console.error('Failed to stop service after startup failure:', stopError);
      }
    }
    embeddingServer.shutdown();
    if (stopped) await releaseStorageRegistration?.();
    if (checkingSafety) throw new StrictSafetyError(`診断に失敗しました: ${String(error)}。保存先を確認し、DB を読み取れない場合は CLI の maintenance force-repair のプレビューを確認してください。`);
    throw error;
  }
}

/**
 * 処理中の書き込みを待ってからサービスを停止する。
 *
 * @param instances - サービスインスタンス群
 */
export async function stopService(instances: ServiceInstances): Promise<void> {
  let stopped = false;
  try {
    await instances.watcherProcess.stop();
    stopped = true;
  } finally {
    try {
      await instances.service.stop();
      await instances.dbEngine.disconnect();
      if (stopped) await instances.releaseStorageRegistration?.();
    } finally {
      instances.embeddingServer.shutdown();
    }
  }
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
