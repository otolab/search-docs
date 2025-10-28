/**
 * 出力フォーマットユーティリティ（シンプル版）
 */

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
export function formatSearchResultsAsText(response: SearchResponse): string {
  if (response.results.length === 0) {
    return `検索結果: 0件（${response.took}ms）`;
  }

  const lines: string[] = [];
  lines.push(`検索結果: ${response.total}件（${response.took}ms）\n`);

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. [score: ${result.score.toFixed(2)}] ${result.heading || '(no heading)'}`);
    lines.push(`   Path: ${result.documentPath}`);
    lines.push(`   Depth: ${result.depth}`);
    if (result.content) {
      const preview = result.content.substring(0, 100);
      lines.push(`   Preview: ${preview}${result.content.length > 100 ? '...' : ''}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}
