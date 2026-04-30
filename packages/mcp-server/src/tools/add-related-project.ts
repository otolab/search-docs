/**
 * add_related_project ツール
 * 関連プロジェクトを一時的に追加する
 */

import { z } from 'zod';
import { SearchDocsClient } from '@search-docs/client';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * add_related_project ツールを登録
 */
export function registerAddRelatedProjectTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState, serverManager } = context;

  return server.registerTool(
    'add_related_project',
    {
      description:
        '関連プロジェクトを一時的に追加します。追加されたプロジェクトはセッション中のみ有効で、設定ファイルには保存されません。\n' +
        '起動済みのsearch-docsサーバに接続します。対象プロジェクトで `search-docs server start` を実行してからURLを指定してください（Docker環境ではlocalhostを自動でhost.docker.internalに補正します）',
      inputSchema: {
        name: z.string().describe('プロジェクト名（一意の識別子）'),
        url: z.string().describe('起動済みサーバのURL（例: http://localhost:<port>）'),
        description: z.string().optional().describe('プロジェクトの説明'),
      },
    },
    async (args: { name: string; url: string; description?: string }) => {
      const { name, url, description } = args;

      // 名前の重複チェック（設定ファイル + 一時追加分）
      const allRelated = serverManager.getAllRelatedProjects(
        systemState.config?.relatedProjects
      );
      if (allRelated[name]) {
        throw new Error(
          `関連プロジェクト "${name}" は既に登録されています。`
        );
      }

      // URL接続確認
      const { ServerManager } = await import('../server-manager.js');
      const resolvedUrl = ServerManager.resolveDockerUrl(url);
      const client = new SearchDocsClient({ baseUrl: resolvedUrl });
      try {
        await client.healthCheck();
      } catch (error) {
        throw new Error(
          `指定されたURLのサーバに接続できません: ${url}\n\n` +
          `エラー: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // 一時追加（URL形式）
      serverManager.addTemporaryRelatedProject(name, {
        url,
        description,
      });

      let resultText = `✅ 関連プロジェクト "${name}" を一時的に追加しました。\n\n`;
      resultText += `  URL: ${url}\n`;
      if (description) {
        resultText += `  説明: ${description}\n`;
      }
      resultText += `\n⚠️  この追加はセッション中のみ有効です。永続化するには設定ファイルを編集してください。\n\n`;
      resultText += '次のステップ:\n';
      resultText += `  - 検索を実行: search(query: "...", project: "${name}")\n`;
      resultText += `  - 一覧を確認: list_related_projects\n`;

      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    }
  );
}
