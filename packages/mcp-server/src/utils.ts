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
 * セクション番号を章節項号形式に変換
 *
 * @param sectionNumber - セクション番号の配列（例: [1, 2, 3, 1]）
 * @returns 章節項号の文字列（例: "第1章2節3項1号"）
 */
export function formatSectionNumber(sectionNumber: number[]): string {
  if (sectionNumber.length === 0) {
    return '';
  }

  const units = ['章', '節', '項', '号'];
  const parts: string[] = [];

  sectionNumber.forEach((num, index) => {
    if (index === 0) {
      parts.push(`第${num}${units[0]}`);
    } else {
      const unit = units[index] || '号';
      parts.push(`${num}${unit}`);
    }
  });

  return parts.join('');
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
