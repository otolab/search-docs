/**
 * search ツール
 * 文書を検索する
 */

import { z } from 'zod';
import { renderSearchResultsText } from '@search-docs/common';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * search ツールを登録
 */
export function registerSearchTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'search',
    {
      description:
        'ドキュメントをVector検索します。関連するセクションが関連性順で返されます。',
      inputSchema: {
        query: z.string().describe('検索クエリ'),
        project: z
          .string()
          .optional()
          .describe('関連プロジェクト名（未指定時はメインプロジェクト）'),
        depth: z
          .number()
          .optional()
          .describe('最大深度（0-3）。この深度まで検索します。0=文書全体のみ、1=章まで、2=節まで、3=項まで。省略時は全階層を検索'),
        limit: z.number().optional().describe('結果数制限（デフォルト: 10）'),
        syncedOnly: z
          .boolean()
          .optional()
          .describe('インデックスがドキュメントと同期済みのセクションのみを検索対象にする（デフォルト: false、未同期のセクションも含めて検索）'),
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
      project?: string;
      depth?: number;
      limit?: number;
      syncedOnly?: boolean;
      includePaths?: string[];
      excludePaths?: string[];
      previewLines?: number;
    }) => {
      const { query, project, depth, limit, syncedOnly: includeCleanOnly, includePaths, excludePaths, previewLines = 5 } = args;

      // プロジェクト指定がある場合は関連プロジェクトを検索
      if (project) {
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects
        );
        const relatedClient = await context.serverManager.connectRelatedProject(project, allRelated);

        // 関連プロジェクトで検索を実行
        try {
          const response = await relatedClient.search({
            query,
            options: {
              depth,
              limit,
              includeCleanOnly,
              includePaths,
              excludePaths,
            },
          });

          const resultText = renderSearchResultsText(response, {
            previewLines,
            projectLabel: project,
            hints: 'mcp',
          });

          return {
            content: [
              {
                type: 'text',
                text: resultText,
              },
            ],
          };
        } catch (error) {
          throw new Error(`関連プロジェクト "${project}" の検索エラー: ${(error as Error).message}`);
        }
      }

      // メインプロジェクトの検索（既存の実装）
      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects
        );
        const relatedNames = Object.keys(allRelated);
        throw new Error(getStateErrorMessage(systemState.state, '文書の検索', relatedNames));
      }

      const service = systemState.service!;

      try {
        const response = await service.search({
          query,
          options: {
            depth,
            limit,
            includeCleanOnly,
            includePaths,
            excludePaths,
          },
        });

        const resultText = renderSearchResultsText(response, {
          previewLines,
          hints: 'mcp',
        });

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
