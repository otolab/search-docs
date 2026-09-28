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
