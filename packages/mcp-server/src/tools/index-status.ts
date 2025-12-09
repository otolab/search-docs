/**
 * index_status ツール
 * インデックスの状態を確認する
 */

import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * index_status ツールを登録
 */
export function registerIndexStatusTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'index_status',
    {
      description: 'インデックスの状態を確認します。総文書数、セクション数、Dirtyセクション数などを表示します。',
      inputSchema: {},
    },
    async () => {
      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, 'インデックス状態の確認'));
      }

      const client = systemState.client!;

      try {
        const response = await client.getStatus();

        let statusText = '📊 インデックス状態\n\n';
        statusText += `サーバ情報:\n`;
        statusText += `  バージョン: ${response.server.version}\n`;
        statusText += `  起動時間: ${(response.server.uptime / 1000).toFixed(1)}秒\n`;
        statusText += `  PID: ${response.server.pid}\n\n`;

        // データベース接続状態を表示
        statusText += 'データベース状態:\n';
        switch (response.database.connectionState) {
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
            if (response.database.connectionError) {
              statusText += `  エラー: ${response.database.connectionError}\n\n`;
            } else {
              statusText += '\n';
            }
            break;
        }

        // DB接続完了時のみインデックス情報を表示
        if (response.database.connectionState === 'ready') {
          statusText += `インデックス情報:\n`;
          statusText += `  総文書数: ${response.index.totalDocuments}件\n`;
          statusText += `  総セクション数: ${response.index.totalSections}件\n`;
          statusText += `  Dirtyセクション: ${response.index.dirtyCount}件\n`;

          if (response.worker) {
            statusText += `\nワーカー情報:\n`;
            statusText += `  実行中: ${response.worker.running ? 'Yes' : 'No'}\n`;
            statusText += `  処理中: ${response.worker.processing}件\n`;
            statusText += `  キュー: ${response.worker.queue}件\n`;
          }
        } else {
          statusText += 'インデックス情報: データベース接続待ち...\n';
          statusText += '\nデータベース接続が完了するまでお待ちください（通常5-10秒程度）。\n';
        }

        return {
          content: [
            {
              type: 'text',
              text: statusText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`ステータス取得エラー: ${(error as Error).message}`);
      }
    }
  );
}
