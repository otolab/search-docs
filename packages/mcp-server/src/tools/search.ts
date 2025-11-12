/**
 * search ツール
 * 文書を検索する
 */

import { z } from 'zod';
import { getStateErrorMessage } from '../state.js';
import { formatSectionNumber, getPreviewContent } from '../utils.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * search ツールを登録
 */
export function registerSearchTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'search',
    {
      description: '文書を検索します。クエリに基づいてVector検索を実行し、関連する文書セクションを返します。検索結果には行番号とセクションIDが含まれます。続きを見るにはget_document(sectionId)を使用してください。limitとpreviewLinesで表示内容を調整できます。',
      inputSchema: {
        query: z.string().describe('検索クエリ'),
        depth: z
          .number()
          .optional()
          .describe('最大深度（0-3）。この深度まで検索します。0=文書全体のみ、1=章まで、2=節まで、3=項まで。省略時は全階層を検索'),
        limit: z.number().optional().describe('結果数制限（デフォルト: 10）'),
        includeCleanOnly: z
          .boolean()
          .optional()
          .describe('最新の文書内容のみを検索対象とする。falseの場合、文書が更新されていても古いインデックスも含めて検索します（デフォルト: false）'),
        includePaths: z
          .array(z.string())
          .optional()
          .describe('包含するドキュメントパス（前方一致）。例: ["docs/", "README.md"]'),
        excludePaths: z
          .array(z.string())
          .optional()
          .describe('除外するドキュメントパス（前方一致）。例: ["docs/internal/", "temp/"]'),
        previewLines: z.number().optional().describe('プレビュー行数（デフォルト: 5）'),
      },
    },
    async (args: {
      query: string;
      depth?: number;
      limit?: number;
      includeCleanOnly?: boolean;
      includePaths?: string[];
      excludePaths?: string[];
      previewLines?: number;
    }) => {
      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, '文書の検索'));
      }

      const { query, depth, limit, includeCleanOnly, includePaths, excludePaths, previewLines = 5 } = args;
      const client = systemState.client!;

      try {
        const response = await client.search({
          query,
          options: {
            depth,
            limit,
            includeCleanOnly,
            includePaths,
            excludePaths,
          },
        });

        // 結果を整形
        let resultText = `検索結果: ${response.total}件\n`;
        resultText += `処理時間: ${response.took}ms\n\n`;

        if (response.results.length === 0) {
          resultText += '該当する結果が見つかりませんでした。';
        } else {
          const total = response.results.length;

          response.results.forEach((result, index) => {
            resultText += '---\n';

            const heading = result.heading || '(no heading)';
            const hierarchy = formatSectionNumber(result.sectionNumber);

            // 1行目: タイトル + 章節項号
            if (hierarchy) {
              resultText += `📄 「${heading}」(${hierarchy})\n`;
            } else {
              // depth=0の場合は章節項号なし
              resultText += `📄 ${heading}\n`;
            }

            // 2行目: ファイルパス
            resultText += `   ${result.documentPath}\n`;

            // 3行目: 行数、順位、ID
            const rank = index + 1;
            resultText += `   ${result.startLine}-${result.endLine}行目 | ${rank}位/${total}件 | id: ${result.id}\n\n`;

            // コンテンツ（インデント）
            const preview = getPreviewContent(result.content, previewLines);
            const indentedContent = preview
              .split('\n')
              .map((line) => `   ${line}`)
              .join('\n');
            resultText += indentedContent + '\n';
          });

          // 検索ヒント
          resultText += '\n💡 検索のヒント:\n';
          resultText += '   - 結果は関連性順（上位ほど関連性が高い）\n';
          resultText += '   - 続きを見る: get_document(sectionId: "...")\n';
          resultText += '   - 件数調整: search(..., { limit: 20 })\n';
          resultText += '   - 表示行数: search(..., { previewLines: 10 })\n';
        }

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`検索エラー: ${(error as Error).message}`);
      }
    }
  );
}
