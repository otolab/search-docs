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
      description:
        '文書の目次構造をトークン数付きで一覧表示します。少ないトークン消費で文書の全体像を把握でき、記述量バランスの確認や読むべきセクションの特定に使えます。各セクションの見出し、行範囲、トークン数、セクションIDが返されます。',
      inputSchema: {
        path: z.string().optional().describe('文書パス（sectionIdを指定しない場合は必須）'),
        sectionId: z.string().optional().describe('セクションID（指定した場合、そのセクション配下のみ表示）'),
        project: z
          .string()
          .optional()
          .describe('関連プロジェクト名（未指定時はメインプロジェクト）'),
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
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects
        );
        const relatedClient = await context.serverManager.connectRelatedProject(project, allRelated);

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
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects
        );
        const relatedNames = Object.keys(allRelated);
        throw new Error(getStateErrorMessage(systemState.state, '文書構造の取得', relatedNames));
      }

      const service = systemState.service!;

      try {
        const response = await service.getOutline({ path: documentPath, sectionId });

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
