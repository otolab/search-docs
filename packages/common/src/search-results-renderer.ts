import type { SearchResponse } from '@search-docs/types';

export type SearchResultsTextHints = 'mcp' | 'cli' | false;

export interface RenderSearchResultsTextOptions {
  /** プレビューに表示する最大行数（デフォルト: 5） */
  previewLines?: number;
  /** 関連プロジェクト名。指定時は結果の前にプロジェクト名を表示する */
  projectLabel?: string;
  /** クライアント固有の検索ヒント。false の場合はヒントを表示しない */
  hints?: SearchResultsTextHints;
}

/**
 * セクション番号を章節項号形式に変換する。
 *
 * @param sectionNumber セクション番号の配列（例: [1, 2, 3, 1]）
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
 * コンテンツのプレビューを取得する（行ベース）。
 *
 * @param content 元のコンテンツ
 * @param maxLines 最大行数（デフォルト: 5）
 */
export function getPreviewContent(content: string, maxLines: number = 5): string {
  const lines = content.split('\n');
  const normalizedMaxLines = Number.isFinite(maxLines)
    ? Math.max(0, Math.floor(maxLines))
    : 5;

  if (lines.length <= normalizedMaxLines) {
    return content;
  }

  const previewLines = lines.slice(0, normalizedMaxLines);
  const remaining = lines.length - normalizedMaxLines;
  previewLines.push(`... (残り${remaining}行)`);

  return previewLines.join('\n');
}

/**
 * SearchResponse を人間向けのテキストへ変換する。
 *
 * MCP と CLI の検索結果はこの関数で共通の本文形式を生成し、
 * ヒントだけを options.hints でクライアントごとに切り替える。
 */
export function renderSearchResultsText(
  response: SearchResponse,
  options: RenderSearchResultsTextOptions = {}
): string {
  const {
    previewLines = 5,
    projectLabel,
    hints = 'mcp',
  } = options;

  let resultText = projectLabel ? `[プロジェクト: ${projectLabel}]\n` : '';
  resultText += `検索結果: ${response.total}件\n`;
  resultText += `処理時間: ${response.took}ms\n\n`;

  if (response.results.length === 0) {
    return resultText + '該当する結果が見つかりませんでした。';
  }

  const total = response.results.length;

  response.results.forEach((result, index) => {
    resultText += '---\n';

    const heading = result.heading || '(no heading)';
    const hierarchy = formatSectionNumber(result.sectionNumber);

    if (hierarchy) {
      resultText += `📄 「${heading}」(${hierarchy})\n`;
    } else {
      resultText += `📄 ${heading}\n`;
    }

    resultText += `   ${result.documentPath}\n`;

    const rank = index + 1;
    const indexStatus = result.indexStatus ?? 'unknown';
    resultText +=
      `   ${result.startLine}-${result.endLine}行目 | ${rank}位/${total}件 | ` +
      `id: ${result.id} | indexStatus: ${indexStatus}\n\n`;

    const preview = getPreviewContent(result.content, previewLines);
    const indentedContent = preview
      .split('\n')
      .map((line) => `   ${line}`)
      .join('\n');
    resultText += indentedContent + '\n';
  });

  if (hints !== false) {
    resultText += '\n💡 検索のヒント:\n';
    resultText += '   - 結果は関連性順（上位ほど関連性が高い）\n';

    if (hints === 'mcp') {
      const projectSuffix = projectLabel ? `, project: "${projectLabel}"` : '';
      const searchOptionsPrefix = projectLabel ? ` project: "${projectLabel}",` : '';
      resultText += `   - 続きを見る: get_document(sectionId: "..."${projectSuffix})\n`;
      resultText += `   - 件数調整: search(..., {${searchOptionsPrefix} limit: 20 })\n`;
      resultText += `   - 表示行数: search(..., {${searchOptionsPrefix} previewLines: 10 })\n`;
    } else {
      resultText += '   - 件数調整: search-docs search "..." --limit 20\n';
      resultText += '   - JSON出力: search-docs search "..." --format json\n';
    }
  }

  return resultText;
}
