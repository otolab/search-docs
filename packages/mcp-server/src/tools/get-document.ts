/**
 * get_document ツール
 * 文書の内容を取得する
 */

import { z } from 'zod';
import { getStateErrorMessage } from '../state.js';
import { getDepthLabel } from '../utils.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * get_document ツールを登録
 */
export function registerGetDocumentTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'get_document',
    {
      description: '文書の内容を取得します。パス指定で文書全体、またはセクションIDで特定セクションを取得できます。pathとsectionIdのどちらか一方は必須です。projectパラメータで関連プロジェクトのドキュメントを取得できます。',
      inputSchema: {
        path: z.string().optional().describe('文書パス（sectionIdを指定しない場合は必須）'),
        sectionId: z.string().optional().describe('セクションID（検索結果から取得。pathを指定しない場合は必須）'),
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

        // 関連プロジェクトから文書を取得
        try {
          const response = await relatedClient.getDocument({ path: documentPath, sectionId });

          if (!response.document && !response.section) {
            throw new Error(`Document or section not found`);
          }

          let resultText = `[プロジェクト: ${project}]\n`;

          // セクション取得の場合
          if (sectionId && response.section) {
            resultText += `セクション: ${response.section.heading || '(no heading)'}\n`;
            resultText += `文書: ${response.section.documentPath}\n`;
            const depthLabel = getDepthLabel(response.section.depth);
            const sectionPath = response.section.sectionNumber.length > 0
              ? response.section.sectionNumber.join('-')
              : 'root';
            resultText += `Level: ${depthLabel} | Section: ${sectionPath} | Line: ${response.section.startLine}-${response.section.endLine}\n\n`;
            resultText += `内容:\n${'='.repeat(60)}\n`;
            resultText += response.section.content;
            resultText += `\n${'='.repeat(60)}`;
          } else if (response.document) {
            // 文書全体取得の場合
            resultText += `文書: ${response.document.path}\n`;
            if (response.document.metadata.title) {
              resultText += `タイトル: ${response.document.metadata.title}\n`;
            }
            resultText += `作成日: ${new Date(response.document.metadata.createdAt).toLocaleString()}\n`;
            resultText += `更新日: ${new Date(response.document.metadata.updatedAt).toLocaleString()}\n\n`;
            resultText += `内容:\n${'='.repeat(60)}\n`;
            resultText += response.document.content;
            resultText += `\n${'='.repeat(60)}`;
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
          throw new Error(`関連プロジェクト "${project}" の文書取得エラー: ${(error as Error).message}`);
        }
      }

      // メインプロジェクトから取得（既存の実装）
      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, '文書の取得'));
      }

      const client = systemState.client!;

      try {
        const response = await client.getDocument({ path: documentPath, sectionId });

        if (!response.document && !response.section) {
          throw new Error(`Document or section not found`);
        }

        let resultText = '';

        // セクション取得の場合
        if (sectionId && response.section) {
          resultText += `セクション: ${response.section.heading || '(no heading)'}\n`;
          resultText += `文書: ${response.section.documentPath}\n`;
          const depthLabel = getDepthLabel(response.section.depth);
          const sectionPath = response.section.sectionNumber.length > 0
            ? response.section.sectionNumber.join('-')
            : 'root';
          resultText += `Level: ${depthLabel} | Section: ${sectionPath} | Line: ${response.section.startLine}-${response.section.endLine}\n\n`;
          resultText += `内容:\n${'='.repeat(60)}\n`;
          resultText += response.section.content;
          resultText += `\n${'='.repeat(60)}`;
        } else if (response.document) {
          // 文書全体取得の場合
          resultText += `文書: ${response.document.path}\n`;
          if (response.document.metadata.title) {
            resultText += `タイトル: ${response.document.metadata.title}\n`;
          }
          resultText += `作成日: ${new Date(response.document.metadata.createdAt).toLocaleString()}\n`;
          resultText += `更新日: ${new Date(response.document.metadata.updatedAt).toLocaleString()}\n\n`;
          resultText += `内容:\n${'='.repeat(60)}\n`;
          resultText += response.document.content;
          resultText += `\n${'='.repeat(60)}`;
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
        throw new Error(`文書取得エラー: ${(error as Error).message}`);
      }
    }
  );
}
