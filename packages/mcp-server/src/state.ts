/**
 * システム状態管理
 */

import { SearchDocsClient } from '@search-docs/client';
import { ConfigLoader, type SearchDocsConfig } from '@search-docs/types';

/**
 * システム状態の種類
 */
export type SystemState = 'NOT_CONFIGURED' | 'CONFIGURED_SERVER_DOWN' | 'RUNNING';

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
  /** サーバURL（設定ファイルが存在する場合） */
  serverUrl?: string;
  /** クライアントインスタンス（サーバが稼働中の場合） */
  client?: SearchDocsClient;
}

/**
 * システム状態を判定
 *
 * @param cwd - カレントワーキングディレクトリ
 * @returns システム状態情報
 */
export async function detectSystemState(cwd: string): Promise<SystemStateInfo> {
  // 1. 設定ファイルの存在確認
  let config: SearchDocsConfig | undefined;
  let configPath: string | undefined;
  let projectRoot: string;

  try {
    const result = await ConfigLoader.resolve({
      cwd,
      requireConfig: false, // エラーで終了しない
    });

    if (!result.config) {
      // 設定ファイルなし
      return {
        state: 'NOT_CONFIGURED',
        projectRoot: cwd,
      };
    }

    config = result.config;
    configPath = result.configPath;
    projectRoot = result.projectRoot;
  } catch (_error) {
    // 設定ファイル読み込みエラー
    return {
      state: 'NOT_CONFIGURED',
      projectRoot: cwd,
    };
  }

  // 2. サーバのヘルスチェック
  const serverUrl = `http://${config.server.host}:${config.server.port}`;
  const client = new SearchDocsClient({ baseUrl: serverUrl });

  try {
    await client.healthCheck();

    // サーバ稼働中
    return {
      state: 'RUNNING',
      config,
      configPath,
      projectRoot,
      serverUrl,
      client,
    };
  } catch (_error) {
    // サーバ停止中
    return {
      state: 'CONFIGURED_SERVER_DOWN',
      config,
      configPath,
      projectRoot,
      serverUrl,
    };
  }
}

/**
 * システム状態に応じたエラーメッセージを生成
 *
 * @param state - システム状態
 * @param action - 実行しようとしたアクション名
 * @returns エラーメッセージ
 */
export function getStateErrorMessage(state: SystemState, action: string): string {
  switch (state) {
    case 'NOT_CONFIGURED':
      return (
        `${action}を実行できません。search-docsがまだセットアップされていません。\n\n` +
        'まず、設定ファイルを作成してください:\n' +
        '  ツール: init\n\n' +
        '設定作成後、サーバを起動してください:\n' +
        '  ツール: server_start'
      );

    case 'CONFIGURED_SERVER_DOWN':
      return (
        `${action}を実行できません。search-docsサーバが起動していません。\n\n` +
        'サーバを起動してください:\n' +
        '  ツール: server_start\n\n' +
        'または、設定を再作成する場合:\n' +
        '  ツール: init (--force オプション付き)'
      );

    case 'RUNNING':
      // サーバ稼働中は通常エラーにならないが、念のため
      return `${action}を実行できません。予期しないエラーが発生しました。`;
  }
}
