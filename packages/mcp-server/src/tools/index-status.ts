/**
 * index_status ツール
 * インデックスの状態を確認する
 */

import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext } from './types.js';

/**
 * index_status ツールを登録
 */
export function registerIndexStatusTool(context: ToolRegistrationContext): void {
  const { server, systemState } = context;

  server.registerTool(
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
