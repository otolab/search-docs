/**
 * get_outline ツール
 * 文書の構造（アウトライン）を取得する
 */

import { z } from 'zod';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * get_outline ツールを登録
 */
export function registerGetOutlineTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'get_outline',
    {
      description: '文書の構造（アウトライン）を取得します。セクション番号、見出し、行数、トークン数、セクションIDを一覧表示します。pathとsectionIdのどちらか一方は必須です。projectパラメータで関連プロジェクトのドキュメントを取得できます。',
      inputSchema: {
        path: z.string().optional().describe('文書パス（sectionIdを指定しない場合は必須）'),
        sectionId: z.string().optional().describe('セクションID（指定した場合、そのセクション配下のみ表示）'),
        project: z
          .string()
          .optional()
          .describe('取得対象のプロジェクト名。未指定の場合はメインプロジェクトから取得します。利用可能なプロジェクト名はlist_related_projectsで確認できます。'),
      },
    },
    async (args: { path?: string; sectionId?: string; project?: string }) => {
      const { path: documentPath, sectionId, project } = args;

      // どちらか一方は必須
      if (!documentPath && !sectionId) {
        throw new Error('pathまたはsectionIdのどちらか一方を指定してください');
      }

      // プロジェクト指定がある場合は関連プロジェクトから取得
      if (project) {
        // 関連プロジェクトのサーバを取得（起動済みのみ）
        const relatedClient = await context.serverManager.getServer(project);
        if (!relatedClient) {
          throw new Error(
            `関連プロジェクト "${project}" のサーバが起動していません。\n\n` +
            `サーバを起動してください:\n` +
            `  server_start(project: "${project}")`
          );
        }

        // 関連プロジェクトからアウトラインを取得
        try {
          const response = await relatedClient.getOutline({ path: documentPath, sectionId });

          let resultText = `[プロジェクト: ${project}]\n`;
          if (documentPath) {
            resultText += `文書: ${documentPath}\n`;
          }
          resultText += `\n`;

          for (const item of response.items) {
            resultText += `${item.number}. "${item.heading}" (lines: ${item.lines}, tokens: ${item.tokens}, id: ${item.id})\n`;
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
          throw new Error(`関連プロジェクト "${project}" のアウトライン取得エラー: ${(error as Error).message}`);
        }
      }

      // メインプロジェクトから取得
      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, '文書構造の取得'));
      }

      const client = systemState.client!;

      try {
        const response = await client.getOutline({ path: documentPath, sectionId });

        let resultText = '';
        if (documentPath) {
          resultText += `文書: ${documentPath}\n`;
        }
        resultText += `\n`;

        for (const item of response.items) {
          resultText += `${item.number}. "${item.heading}" (lines: ${item.lines}, tokens: ${item.tokens}, id: ${item.id})\n`;
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
        throw new Error(`アウトライン取得エラー: ${(error as Error).message}`);
      }
    }
  );
}
