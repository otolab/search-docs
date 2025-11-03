/**
 * 共通ユーティリティ関数
 */

/**
 * depthを分かりやすいラベルに変換
 *
 * @param depth - 深度（0-3）
 * @returns ラベル文字列
 */
export function getDepthLabel(depth: number): string {
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
 *
 * @param content - 元のコンテンツ
 * @param maxLines - 最大行数（デフォルト: 5）
 * @returns プレビュー文字列
 */
export function getPreviewContent(content: string, maxLines: number = 5): string {
  const lines = content.split('\n');

  if (lines.length <= maxLines) {
    return content;
  }

  const previewLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  previewLines.push(`... (残り${remaining}行)`);

  return previewLines.join('\n');
}
