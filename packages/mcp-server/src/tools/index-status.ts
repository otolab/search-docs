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

  if (response.database.connectionState === 'ready') {
    text += `インデックス情報:\n`;
    text += `  総文書数: ${response.index.totalDocuments}件\n`;
    text += `  総セクション数: ${response.index.totalSections}件\n`;
    text += `  Dirtyセクション: ${response.index.dirtyCount}件\n\n`;

    // Watcher状態
    if (response.watcher) {
      text += `Watcher:\n`;
      text += `  状態: ${response.watcher.state}\n`;
      text += `  Writer ID: ${response.watcher.writerId}\n\n`;
    }

    // ワーカー状態
    text += `ワーカー:\n`;
    text += `  実行中: ${response.worker.running ? 'Yes' : 'No'}\n`;
    text += `  キュー: ${response.worker.queue}件\n`;
  } else if (response.database.connectionState === 'error') {
    text += `データベースエラー: ${response.database.connectionError || '不明'}\n`;
  } else {
    text += 'データベース準備中...\n';
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
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects
        );
        const relatedClient = await context.serverManager.connectRelatedProject(project, allRelated);

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
          systemState.config?.relatedProjects
        );
        const relatedNames = Object.keys(allRelated);
        throw new Error(getStateErrorMessage(systemState.state, 'インデックス状態の確認', relatedNames));
      }

      const service = systemState.service!;

      try {
        const response = await service.getStatus();
        let statusText = '📊 インデックス状態\n\n';
        statusText += formatIndexStatus(response);
        return { content: [{ type: 'text' as const, text: statusText }] };
      } catch (error) {
        throw new Error(`ステータス取得エラー: ${(error as Error).message}`);
      }
    }
  );
}
