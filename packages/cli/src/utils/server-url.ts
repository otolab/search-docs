/**
 * サーバURL解決ユーティリティ
 */

import { ConfigLoader } from '@search-docs/types';

/**
 * サーバURL解決オプション
 */
export interface ResolveServerUrlOptions {
  /** 明示的に指定されたサーバURL（最優先） */
  server?: string;
  /** 設定ファイルパス */
  config?: string;
}

/**
 * サーバURLを解決
 *
 * 優先順位:
 * 1. --server オプション（明示的指定）
 * 2. 設定ファイルの server.host + server.port
 * 3. デフォルト: http://localhost:24280
 */
export async function resolveServerUrl(
  options: ResolveServerUrlOptions = {}
): Promise<string> {
  // 1. 明示的に指定されている場合は最優先
  if (options.server) {
    return options.server;
  }

  try {
    // 2. 設定ファイルからポート番号を取得
    const { config } = await ConfigLoader.resolve({
      configPath: options.config,
    });

    // server設定からURLを構築
    const host = config.server.host || 'localhost';
    const port = config.server.port || 24280;
    return `http://${host}:${port}`;
  } catch (error) {
    // 設定ファイルが読み込めない場合はデフォルトにフォールバック
    // エラーは握りつぶす（設定ファイルがない場合もある）
  }

  // 3. デフォルト
  return 'http://localhost:24280';
}
