/**
 * 出力フォーマットユーティリティ（シンプル版）
 */

import {
  renderSearchResultsText,
  type RenderSearchResultsTextOptions,
} from '@search-docs/common';
import type { SearchResponse } from '@search-docs/types';

/**
 * 検索結果をJSON形式で出力
 */
export function formatSearchResultsAsJson(response: SearchResponse): string {
  return JSON.stringify(response, null, 2);
}


/**
 * 検索結果をテキスト形式で出力
 */
export function formatSearchResultsAsText(
  response: SearchResponse,
  options: RenderSearchResultsTextOptions | number = {}
): string {
  const rendererOptions: RenderSearchResultsTextOptions =
    typeof options === 'number'
      ? { previewLines: options, hints: 'cli' }
      : { ...options, hints: options.hints ?? 'cli' };

  return renderSearchResultsText(response, rendererOptions);
}
