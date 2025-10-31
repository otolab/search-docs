/**
 * search コマンド実装（シンプル版）
 */

import { SearchDocsClient, JsonRpcClientError } from '@search-docs/client';
import type { SearchRequest } from '@search-docs/types';
import {
  formatSearchResultsAsJson,
  formatSearchResultsAsText,
} from '../utils/output.js';
import { resolveServerUrl } from '../utils/server-url.js';

export interface SearchCommandOptions {
  limit?: string;
  depth?: string[];
  format?: 'text' | 'json';
  cleanOnly?: boolean;
  server?: string;
  config?: string;
}

/**
 * search コマンドを実行
 */
export async function executeSearch(
  query: string,
  options: SearchCommandOptions
): Promise<void> {
  try {
    // サーバURLを解決
    const baseUrl = await resolveServerUrl({
      server: options.server,
      config: options.config,
    });

    // クライアント作成
    const client = new SearchDocsClient({
      baseUrl,
    });

    // リクエスト構築
    const request: SearchRequest = {
      query,
      options: {
        limit: options.limit ? parseInt(options.limit, 10) : 10,
        depth: options.depth?.map((d) => parseInt(d, 10)),
        includeCleanOnly: options.cleanOnly || false,
      },
    };

    // 検索実行
    const response = await client.search(request);

    // 結果を出力
    const format = options.format || 'text';
    const output = format === 'json'
      ? formatSearchResultsAsJson(response)
      : formatSearchResultsAsText(response);

    console.log(output);
  } catch (error) {
    if (error instanceof JsonRpcClientError) {
      console.error(`エラー [${error.code}]: ${error.message}`);
      if (error.data) {
        console.error('詳細:', error.data);
      }
    } else if (error instanceof Error) {
      if (error.message.includes('fetch')) {
        console.error('エラー: サーバに接続できません。サーバが起動していることを確認してください。');
      } else if (error.message.includes('timeout')) {
        console.error('エラー: リクエストがタイムアウトしました。');
      } else {
        console.error(`エラー: ${error.message}`);
      }
    } else {
      console.error('エラー: 不明なエラーが発生しました。');
    }
    process.exit(1);
  }
}
