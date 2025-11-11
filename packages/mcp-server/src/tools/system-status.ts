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
        'search-docsシステムの状態を取得します。設定ファイルの有無、サーバの起動状態、インデックス情報を確認できます。',
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
            statusText += 'インデックス情報:\n';
            statusText += `  総文書数: ${status.index.totalDocuments}件\n`;
            statusText += `  総セクション数: ${status.index.totalSections}件\n`;
            statusText += `  Dirtyセクション: ${status.index.dirtyCount}件\n\n`;

            if (status.index.dirtyCount > 0) {
              statusText += `⚠️  ${status.index.dirtyCount}件の文書が更新待ちです。\n`;
              statusText += 'バックグラウンドで順次インデックスが更新されます。\n';
            }
          } catch (error) {
            statusText += `⚠️  サーバ情報の取得に失敗: ${(error as Error).message}\n`;
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
