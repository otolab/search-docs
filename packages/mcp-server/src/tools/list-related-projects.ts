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
        '設定ファイルで定義された関連プロジェクトの一覧を表示します。各プロジェクトの名前、説明、ディレクトリ、サーバの起動状態を確認できます。search、get_document、get_outlineのprojectパラメータで使用するプロジェクト名を確認するために使用してください。',
      inputSchema: {},
    },
    async () => {
      let resultText = '';

      // 設定ファイルが必要
      if (systemState.state === 'NOT_CONFIGURED') {
        resultText += '⚠️  関連プロジェクトを確認するには、まず設定ファイルが必要です。\n\n';
        resultText += '設定ファイルを作成してください:\n';
        resultText += '  ツール: init\n';

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      }

      // 関連プロジェクトの存在確認
      if (!systemState.config?.relatedProjects || Object.keys(systemState.config.relatedProjects).length === 0) {
        resultText += '📋 関連プロジェクト\n\n';
        resultText += '関連プロジェクトは設定されていません。\n\n';
        resultText += '設定ファイルで関連プロジェクトを定義することで、複数のプロジェクトを検索できます。\n';

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

      const relatedProjects = Object.keys(systemState.config.relatedProjects);
      const allServers = context.serverManager.getAllServers();

      for (const projectName of relatedProjects) {
        const projectConfig = systemState.config.relatedProjects[projectName];
        const serverInfo = allServers.get(projectName);

        resultText += `• ${projectName}`;

        if (projectConfig.description) {
          resultText += ` - ${projectConfig.description}`;
        }

        resultText += '\n';
        resultText += `  ディレクトリ: ${projectConfig.dir}\n`;

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
