/**
 * index_status ツール
 * インデックスの状態を確認する
 */

import { z } from 'zod';
import type { GetStatusResponse } from '@search-docs/types';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * ステータスレスポンスからインデックス状態のテキストを生成
 */
function formatIndexStatus(response: GetStatusResponse): string {
  let text = '';

  text += `サーバ情報:\n`;
  text += `  バージョン: ${response.server.version}\n`;
  text += `  起動時間: ${(response.server.uptime / 1000).toFixed(1)}秒\n`;
  text += `  PID: ${response.server.pid}\n\n`;

  text += 'データベース状態:\n';
  switch (response.database.connectionState) {
    case 'disconnected':
      text += '  状態: 切断\n\n';
      break;
    case 'connecting':
      text += '  状態: 接続中...\n';
      text += '  進行状況: Pythonワーカーとデータベース接続を開始中\n\n';
      break;
    case 'initializing_model':
      text += '  状態: モデル読み込み中...\n';
      text += '  進行状況: Ruri埋め込みモデルを初期化中（5-10秒程度）\n\n';
      break;
    case 'ready':
      text += '  状態: 接続完了 ✅\n\n';
      break;
    case 'error':
      text += '  状態: エラー ❌\n';
      if (response.database.connectionError) {
        text += `  エラー: ${response.database.connectionError}\n\n`;
      } else {
        text += '\n';
      }
      break;
  }

  if (response.database.connectionState === 'ready') {
    text += `インデックス情報:\n`;
    text += `  総文書数: ${response.index.totalDocuments}件\n`;
    text += `  総セクション数: ${response.index.totalSections}件\n`;
    text += `  Dirtyセクション: ${response.index.dirtyCount}件\n`;

    if (response.worker) {
      text += `\nワーカー情報:\n`;
      text += `  実行中: ${response.worker.running ? 'Yes' : 'No'}\n`;
      text += `  処理中: ${response.worker.processing}件\n`;
      text += `  キュー: ${response.worker.queue}件\n`;
    }
  } else {
    text += 'インデックス情報: データベース接続待ち...\n';
    text += '\nデータベース接続が完了するまでお待ちください（通常5-10秒程度）。\n';
  }

  return text;
}

/**
 * index_status ツールを登録
 */
export function registerIndexStatusTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'index_status',
    {
      description:
        'インデックスの詳細な状態を確認します。文書の更新反映を待っているときや、ワーカーの動作状況を確認したいときに使用します。文書数、セクション数、Dirty数、ワーカー状態が返されます。',
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe('関連プロジェクト名（未指定時はメインプロジェクト）'),
      },
    },
    async (args: { project?: string }) => {
      const { project } = args;

      if (project) {
        // 関連プロジェクトのインデックス状態
        const relatedClient = await context.serverManager.getServer(project);
        if (!relatedClient) {
          throw new Error(
            `関連プロジェクト "${project}" のサーバが起動していません。\n\n` +
            `サーバを起動してください:\n` +
            `  server_start(project: "${project}")`
          );
        }

        try {
          const response = await relatedClient.getStatus();
          let statusText = `📊 インデックス状態 [プロジェクト: ${project}]\n\n`;
          statusText += formatIndexStatus(response);
          return { content: [{ type: 'text' as const, text: statusText }] };
        } catch (error) {
          throw new Error(`関連プロジェクト "${project}" のステータス取得エラー: ${(error as Error).message}`);
        }
      }

      // 状態チェック
      if (systemState.state !== 'RUNNING') {
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects,
          systemState.configPath
        );
        const relatedNames = Object.keys(allRelated);
        throw new Error(getStateErrorMessage(systemState.state, 'インデックス状態の確認', relatedNames));
      }

      const client = systemState.client!;

      try {
        const response = await client.getStatus();
        let statusText = '📊 インデックス状態\n\n';
        statusText += formatIndexStatus(response);
        return { content: [{ type: 'text' as const, text: statusText }] };
      } catch (error) {
        throw new Error(`ステータス取得エラー: ${(error as Error).message}`);
      }
    }
  );
}
