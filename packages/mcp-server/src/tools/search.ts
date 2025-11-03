/**
 * search ツール
 * 文書を検索する
 */

import { z } from 'zod';
import { getStateErrorMessage } from '../state.js';
import { getDepthLabel, getPreviewContent } from '../utils.js';
import type { ToolRegistrationContext } from './types.js';

/**
 * search ツールを登録
 */
export function registerSearchTool(context: ToolRegistrationContext): void {
  const { server, systemState } = context;

  server.registerTool(
    'search',
    {
      description: '文書を検索します。クエリに基づいてVector検索を実行し、関連する文書セクションを返します。検索結果には行番号(startLine-endLine)とセクションIDが含まれるため、Readツールで該当箇所を直接参照したり、get_documentでセクション全体を取得できます。',
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
        previewLines: z.number().optional().describe('プレビュー行数（デフォルト: 5）'),
      },
    },
    async (args: {
      query: string;
      depth?: number;
      limit?: number;
      includeCleanOnly?: boolean;
      previewLines?: number;
    }) => {
      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, '文書の検索'));
      }

      const { query, depth, limit, includeCleanOnly, previewLines = 5 } = args;
      const client = systemState.client!;

      try {
        const response = await client.search({
          query,
          options: {
            depth,
            limit,
            includeCleanOnly,
          },
        });

        // 結果を整形
        let resultText = `検索結果: ${response.total}件\n`;
        resultText += `処理時間: ${response.took}ms\n\n`;

        if (response.results.length === 0) {
          resultText += '該当する結果が見つかりませんでした。';
        } else {
          response.results.forEach((result, index) => {
            // ヘッダー行
            const heading = result.heading || '(no heading)';
            resultText += `${index + 1}. ${result.documentPath} > ${heading}\n`;

            // メタデータ（1行にまとめる）
            const depthLabel = getDepthLabel(result.depth);
            const sectionPath = result.sectionNumber.join('-');
            const metaParts = [
              `Level: ${depthLabel}`,
              `Section: ${sectionPath}`,
              `Line: ${result.startLine}-${result.endLine}`,
              `Score: ${result.score.toFixed(4)}`,
            ];

            // indexStatusが'updating'または'outdated'の場合のみ表示
            if (result.indexStatus === 'updating' || result.indexStatus === 'outdated') {
              metaParts.push(`Status: ${result.indexStatus}`);
            }

            resultText += metaParts.join(' | ') + '\n\n';

            // コンテンツ（引用として明確に）
            resultText += '```markdown\n';
            const preview = getPreviewContent(result.content, previewLines);
            resultText += preview + '\n';
            resultText += '```\n\n';

            // セクションID（get_documentで取得するため）
            resultText += `(セクションID: ${result.id})\n\n`;
          });
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
