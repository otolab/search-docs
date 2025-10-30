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
 * indexStatusをラベル化
 */
function getStatusLabel(indexStatus?: 'latest' | 'outdated' | 'updating'): string {
  if (!indexStatus) {
    return '';
  }

  switch (indexStatus) {
    case 'latest':
      return '[最新]';
    case 'updating':
      return '[更新中]';
    case 'outdated':
      return '[古い]';
    default:
      return '';
  }
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
    const statusLabel = getStatusLabel(result.indexStatus);
    lines.push(
      `${index + 1}. [score: ${result.score.toFixed(2)}] ${result.heading || '(no heading)'} ${statusLabel}`
    );
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
