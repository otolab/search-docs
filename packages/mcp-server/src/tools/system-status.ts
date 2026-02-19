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
        case 'NOT_CONFIGURED':
          statusText += '状態: 未設定\n\n';
          statusText += 'search-docsがまだセットアップされていません。\n\n';
          statusText += 'まず、設定ファイルを作成してください:\n';
          statusText += '  ツール: init\n\n';
          statusText += '設定作成後、サーバを起動してください:\n';
          statusText += '  ツール: server_start\n';
          break;

        case 'CONFIGURED_SERVER_DOWN':
          statusText += '状態: 設定済み・サーバ停止中\n\n';
          statusText += `設定ファイル: ${systemState.configPath}\n`;
          statusText += `プロジェクト: ${systemState.config?.project.name}\n`;
          statusText += `ポート: ${systemState.config?.server.port}\n\n`;
          statusText += 'サーバを起動してください:\n';
          statusText += '  ツール: server_start\n';
          break;

        case 'RUNNING':
          statusText += '状態: 稼働中 ✅\n\n';
          statusText += `設定ファイル: ${systemState.configPath}\n`;
          statusText += `プロジェクト: ${systemState.config?.project.name}\n`;
          statusText += `サーバURL: ${systemState.serverUrl}\n\n`;

          // サーバ情報を取得
          try {
            const status = await systemState.client!.getStatus();
            statusText += 'サーバ情報:\n';
            statusText += `  バージョン: ${status.server.version}\n`;
            statusText += `  PID: ${status.server.pid}\n`;
            statusText += `  起動時間: ${(status.server.uptime / 1000).toFixed(1)}秒\n\n`;

            // データベース接続状態を表示
            statusText += 'データベース状態:\n';
            switch (status.database.connectionState) {
              case 'disconnected':
                statusText += '  状態: 切断\n\n';
                break;
              case 'connecting':
                statusText += '  状態: 接続中...\n';
                statusText += '  進行状況: Pythonワーカーとデータベース接続を開始中\n\n';
                break;
              case 'initializing_model':
                statusText += '  状態: モデル読み込み中...\n';
                statusText += '  進行状況: Ruri埋め込みモデルを初期化中（5-10秒程度）\n\n';
                break;
              case 'ready':
                statusText += '  状態: 接続完了 ✅\n\n';
                break;
              case 'error':
                statusText += '  状態: エラー ❌\n';
                if (status.database.connectionError) {
                  statusText += `  エラー: ${status.database.connectionError}\n\n`;
                } else {
                  statusText += '\n';
                }
                break;
            }

            // DB接続完了時のみインデックス情報を表示
            if (status.database.connectionState === 'ready') {
              statusText += 'インデックス情報:\n';
              statusText += `  総文書数: ${status.index.totalDocuments}件\n`;
              statusText += `  総セクション数: ${status.index.totalSections}件\n`;
              statusText += `  Dirtyセクション: ${status.index.dirtyCount}件\n\n`;

              if (status.index.dirtyCount > 0) {
                statusText += `⚠️  ${status.index.dirtyCount}件の文書が更新待ちです。\n`;
                statusText += 'バックグラウンドで順次インデックスが更新されます。\n';
              }
            } else {
              statusText += 'インデックス情報: データベース接続待ち...\n\n';
            }
          } catch (error) {
            statusText += `⚠️  サーバ情報の取得に失敗: ${(error as Error).message}\n`;
          }

          // 関連プロジェクト情報を表示
          if (systemState.config?.relatedProjects) {
            const relatedProjects = Object.keys(systemState.config.relatedProjects);
            if (relatedProjects.length > 0) {
              statusText += '\n関連プロジェクト:\n';

              const allServers = context.serverManager.getAllServers();

              for (const projectName of relatedProjects) {
                const projectConfig = systemState.config.relatedProjects[projectName];
                const serverInfo = allServers.get(projectName);

                statusText += `  • ${projectName}`;

                if (projectConfig.description) {
                  statusText += ` - ${projectConfig.description}`;
                }

                statusText += '\n';
                statusText += `    ディレクトリ: ${projectConfig.dir}\n`;

                if (serverInfo) {
                  // サーバが起動中
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

              statusText += '\n💡 関連プロジェクトを検索するには:\n';
              statusText += '  search(query: "...", project: "プロジェクト名")\n';
              statusText += '  get_document(path: "...", project: "プロジェクト名")\n';
            }
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
