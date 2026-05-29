/**
 * maintenance_repair ツール
 * LanceDBテーブルの破損を検出・修復する
 */

import * as path from 'path';
import { DBEngine } from '@search-docs/db-engine';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';
import type { RepairTablesResponse } from '@search-docs/db-engine';

function formatRepairResult(response: RepairTablesResponse): string {
  let text = '🔧 テーブル修復結果\n\n';

  for (const [tableName, result] of Object.entries(response.tables)) {
    const icon = result.status === 'ok' ? '✓' : '⚠';
    text += `  ${icon} ${tableName}: ${result.status}`;
    if (result.action) {
      text += ` → ${result.action}`;
    }
    if (result.error) {
      text += `\n    エラー: ${result.error}`;
    }
    text += '\n';
  }

  if (response.initTablesError) {
    text += `\n❌ テーブル再初期化エラー: ${response.initTablesError}\n`;
  }

  if (response.createdCount) {
    text += `\n${response.createdCount}個のテーブルを新規作成しました。\n`;
  }

  if (response.repairedCount > 0) {
    text += `${response.repairedCount}個の破損テーブルを修復しました。\n`;
    text += 'インデックスデータが失われているため、再インデックスが必要です。\n';
    text += '→ CLIの場合: search-docs index rebuild --force\n';
  } else if (!response.createdCount) {
    text += '\n全テーブル正常です。修復の必要はありません。\n';
  }

  return text;
}

export function registerMaintenanceRepairTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'maintenance_repair',
    {
      description:
        'LanceDBテーブルの破損を検出し、自動修復します。破損テーブルはdrop→再作成されます。修復後は再インデックス（index rebuild）が必要です。',
      inputSchema: {},
    },
    async () => {
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, 'テーブル修復'));
      }

      const dbEngine = context.getDbEngine?.();
      if (dbEngine) {
        const result = await dbEngine.repairTables();
        const text = formatRepairResult(result);
        return { content: [{ type: 'text' as const, text }] };
      }

      // serviceInstances が null（DB破損でサービス作成失敗時）のフォールバック
      if (!systemState.config) {
        throw new Error('設定が読み込めません。');
      }

      const dbPath = path.resolve(systemState.projectRoot, systemState.config.storage.indexPath);
      const fallbackEngine = new DBEngine({ dbPath, readOnly: false });
      try {
        await fallbackEngine.connect({ skipInitModel: true });
        const result = await fallbackEngine.repairTables();
        const text = formatRepairResult(result);
        return { content: [{ type: 'text' as const, text }] };
      } finally {
        fallbackEngine.disconnect();
      }
    }
  );
}
