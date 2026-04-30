/**
 * get_system_status ツール
 * システム全体の状態を取得する
 */

import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * get_system_status ツールを登録
 */
export function registerSystemStatusTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'get_system_status',
    {
      description:
        'search-docsの全体状態を確認します。初回セットアップ時や動作確認に使用してください。設定状態、サーバ起動状態、インデックス情報、関連プロジェクト一覧が返されます。',
      inputSchema: {},
    },
    async () => {
      let statusText = '📊 search-docs システム状態\n\n';

      switch (systemState.state) {
        case 'NOT_CONFIGURED': {
          statusText += '状態: 未設定\n\n';
          statusText += 'search-docsがまだセットアップされていません。\n\n';
          statusText += 'セットアップ方法:\n';
          statusText += '  - 設定ファイルを作成: init\n';
          statusText += '  - 関連プロジェクトを追加: add_related_project（dirでローカル追加、urlで起動済みサーバに接続）\n';

          // 一時追加の関連プロジェクトがあれば表示
          const notConfiguredRelated = context.serverManager.getAllRelatedProjects();
          const notConfiguredRelatedNames = Object.keys(notConfiguredRelated);
          if (notConfiguredRelatedNames.length > 0) {
            statusText += '\n関連プロジェクト:\n';
            const allServers = context.serverManager.getAllServers();
            for (const projectName of notConfiguredRelatedNames) {
              const projectConfig = notConfiguredRelated[projectName];
              const serverInfo = allServers.get(projectName);
              statusText += `  • ${projectName}`;
              if (projectConfig.description) {
                statusText += ` - ${projectConfig.description}`;
              }
              statusText += '\n';
              statusText += `    URL: ${projectConfig.url}\n`;
              if (serverInfo) {
                try {
                  await serverInfo.client.healthCheck();
                  statusText += `    状態: 稼働中 ✅\n`;
                  statusText += `    ポート: ${serverInfo.port}\n`;
                } catch {
                  statusText += `    状態: 停止中\n`;
                }
              } else {
                statusText += `    状態: 未起動\n`;
              }
            }
          }

          break;
        }

        case 'RUNNING':
          statusText += '状態: 稼働中 ✅\n\n';
          statusText += `設定ファイル: ${systemState.configPath}\n`;
          statusText += `プロジェクト: ${systemState.config?.project.name}\n\n`;

          try {
            const status = await systemState.service!.getStatus();

            if (status.database.connectionState === 'ready') {
              statusText += 'インデックス情報:\n';
              statusText += `  総文書数: ${status.index.totalDocuments}件\n`;
              statusText += `  総セクション数: ${status.index.totalSections}件\n`;
              statusText += `  Dirtyセクション: ${status.index.dirtyCount}件\n\n`;

              if (status.index.dirtyCount > 0) {
                statusText += `⚠️  ${status.index.dirtyCount}件の文書が更新待ちです。\n`;
                statusText += 'バックグラウンドで順次インデックスが更新されます。\n\n';
              }

              // Watcher状態
              if (status.watcher) {
                statusText += 'Watcher:\n';
                statusText += `  状態: ${status.watcher.state}\n`;
                statusText += `  Writer ID: ${status.watcher.writerId}\n\n`;
              }

              // ワーカー状態
              statusText += 'ワーカー:\n';
              statusText += `  実行中: ${status.worker.running ? 'Yes' : 'No'}\n`;
              statusText += `  キュー: ${status.worker.queue}件\n`;
            } else if (status.database.connectionState === 'error') {
              statusText += `データベースエラー: ${status.database.connectionError || '不明'}\n`;
            } else {
              statusText += 'データベース準備中...\n';
            }
          } catch (error) {
            statusText += `⚠️  情報の取得に失敗: ${(error as Error).message}\n`;
          }

          // 関連プロジェクト情報
          {
            const allRelatedProjects = context.serverManager.getAllRelatedProjects(systemState.config?.relatedProjects);
            const relatedProjectNames = Object.keys(allRelatedProjects);
            if (relatedProjectNames.length > 0) {
              statusText += '\n関連プロジェクト:\n';

              const allServers = context.serverManager.getAllServers();

              for (const projectName of relatedProjectNames) {
                const projectConfig = allRelatedProjects[projectName];
                const serverInfo = allServers.get(projectName);

                statusText += `  • ${projectName}`;
                if (projectConfig.description) {
                  statusText += ` - ${projectConfig.description}`;
                }

                if (serverInfo) {
                  try {
                    await serverInfo.client.healthCheck();
                    statusText += ' ✅';
                  } catch {
                    statusText += ' (停止中)';
                  }
                }
                if (projectConfig.url) {
                  statusText += ` [URL: ${projectConfig.url}]`;
                }
                statusText += '\n';
              }
            }

            statusText += '\n他のプロジェクトの文書を検索するには: add_related_project\n';
          }

          break;
      }

      return {
        content: [
          {
            type: 'text',
            text: statusText,
          },
        ],
      };
    }
  );
}
