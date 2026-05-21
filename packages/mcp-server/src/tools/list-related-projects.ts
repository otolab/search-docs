/**
 * list_related_projects ツール
 * 関連プロジェクトの一覧を表示する
 */

import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * list_related_projects ツールを登録
 */
export function registerListRelatedProjectsTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'list_related_projects',
    {
      description:
        '関連プロジェクトの一覧を取得します。設定ファイルで定義されたものとadd_related_projectで追加されたものの両方を表示します。',
      inputSchema: {},
    },
    async () => {
      let resultText = '';

      // 関連プロジェクトの存在確認
      const allRelatedProjects = context.serverManager.getAllRelatedProjects(systemState.config?.relatedProjects);
      if (Object.keys(allRelatedProjects).length === 0) {
        resultText += '📋 関連プロジェクト\n\n';
        resultText += '関連プロジェクトはありません。\n\n';
        resultText += 'add_related_projectで追加するか、設定ファイルで定義できます。\n';

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      }

      // 関連プロジェクト一覧を表示
      resultText += '📋 関連プロジェクト一覧\n\n';

      const relatedProjectNames = Object.keys(allRelatedProjects);
      const allServers = context.serverManager.getAllServers();

      for (const projectName of relatedProjectNames) {
        const projectConfig = allRelatedProjects[projectName];
        const serverInfo = allServers.get(projectName);

        resultText += `• ${projectName}`;

        if (projectConfig.description) {
          resultText += ` - ${projectConfig.description}`;
        }

        resultText += '\n';
        resultText += `  URL: ${projectConfig.url}\n`;

        if (serverInfo) {
          // サーバが起動中
          try {
            await serverInfo.client.healthCheck();
            resultText += `  状態: 稼働中 ✅\n`;
            resultText += `  ポート: ${serverInfo.port}\n`;
          } catch {
            resultText += `  状態: 停止中\n`;
          }
        } else {
          resultText += `  状態: 未起動\n`;
        }

        resultText += '\n';
      }

      // 使い方のヒント
      resultText += '💡 関連プロジェクトを検索・参照するには:\n';
      resultText += '  search(query: "検索キーワード", project: "プロジェクト名")\n';
      resultText += '  get_document(path: "ファイルパス", project: "プロジェクト名")\n';
      resultText += '  get_outline(path: "ファイルパス", project: "プロジェクト名")\n';

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
