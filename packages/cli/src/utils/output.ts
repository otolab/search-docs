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
 * depthを分かりやすいラベルに変換
 */
function getDepthLabel(depth: number): string {
  const labels = [
    'document (全体)',
    'H1 (章)',
    'H2 (節)',
    'H3 (項)',
  ];
  return labels[depth] || `depth-${depth}`;
}

/**
 * コンテンツのプレビューを取得（行ベース）
 */
function getPreviewContent(content: string, maxLines: number = 5): string {
  const lines = content.split('\n');

  if (lines.length <= maxLines) {
    return content;
  }

  const previewLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  previewLines.push(`... (残り${remaining}行)`);

  return previewLines.join('\n');
}

/**
 * 検索結果をテキスト形式で出力
 */
export function formatSearchResultsAsText(response: SearchResponse, previewLines: number = 5): string {
  if (response.results.length === 0) {
    return `検索結果: 0件（${response.took}ms）`;
  }

  const lines: string[] = [];
  lines.push(`検索結果: ${response.total}件（${response.took}ms）\n`);

  response.results.forEach((result, index) => {
    // ヘッダー行
    const heading = result.heading || '(no heading)';
    lines.push(`${index + 1}. ${result.documentPath} > ${heading}`);

    // メタデータ（1行にまとめる）
    const depthLabel = getDepthLabel(result.depth);
    const sectionPath = result.sectionNumber.join('-');
    const metaParts = [
      `Level: ${depthLabel}`,
      `Section: ${sectionPath}`,
      `Line: ${result.startLine}-${result.endLine}`,
      `Score: ${result.score.toFixed(2)}`,
    ];

    // indexStatusが'updating'または'outdated'の場合のみ表示
    if (result.indexStatus === 'updating' || result.indexStatus === 'outdated') {
      metaParts.push(`Status: ${result.indexStatus}`);
    }

    lines.push(metaParts.join(' | '));

    // コンテンツ（引用として明確に）
    lines.push('');
    lines.push('```markdown');
    const preview = getPreviewContent(result.content, previewLines);
    lines.push(preview);
    lines.push('```');

    // セクションID（get_documentで取得するため）
    lines.push(`(セクションID: ${result.id})`);
    lines.push('');
  });

  return lines.join('\n');
}
