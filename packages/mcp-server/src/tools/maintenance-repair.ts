/**
 * maintenance_repair ツール
 * LanceDBテーブルの破損を検出・修復する
 */

import * as path from 'path';
import { DBEngine, strictMaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { diagnoseStrictConfig } from '@search-docs/server';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';
import type { RepairTablesResponse } from '@search-docs/db-engine';

function formatRepairResult(response: RepairTablesResponse): string {
  let text = '🔧 テーブル修復結果\n\n';
  let unreadable = false;

  for (const [tableName, result] of Object.entries(response.tables)) {
    const icon = result.status === 'ok' ? '✓' : '⚠';
    text += `  ${icon} ${tableName}: ${result.status}`;
    if (result.action) {
      text += ` → ${result.action}`;
    }
    if (result.error) {
      unreadable = true;
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

  if (unreadable) {
    text += 'テーブルを変更していません。バックアップし、CLI の maintenance force-repair を確認してください。\n';
  } else if (response.repairedCount > 0) {
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
        'LanceDBテーブルの読み取りを確認します。読み取れないテーブルは変更せず、CLI の強制修復を案内します。',
      inputSchema: {},
    },
    async () => (context.runDbRequest ?? (operation => operation()))(async () => {
      if (systemState.state !== 'RUNNING') {
        throw new Error(getStateErrorMessage(systemState.state, 'テーブル修復'));
      }

      if (!systemState.config) {
        throw new Error('設定が読み込めません。');
      }

      const dbPath = path.resolve(systemState.projectRoot, systemState.config.storage.indexPath);
      const lock = await strictMaintenanceLock({
        projectRoot: systemState.projectRoot,
        indexPath: systemState.config.storage.indexPath,
        documentsPath: systemState.config.storage.documentsPath,
        files: systemState.config.files,
      });
      const release = await lock.acquireShared();
      let releaseAdmission: (() => Promise<void>) | undefined;
      let fallbackEngine: DBEngine | undefined;
      let retainRegistration = false;
      try {
        releaseAdmission = await lock.acquireAdmission();
        try {
          await diagnoseStrictConfig(systemState.config);
        } catch (error) {
          if (error instanceof UnconfirmedProcessStopError) retainRegistration = true;
          throw new Error(`修復前の診断に失敗しました: ${String(error)}。データをバックアップし、CLI の強制修復手順を確認してください。`);
        }
        const dbEngine = context.getDbEngine?.();
        if (dbEngine) {
          const result = await dbEngine.repairTables();
          return { content: [{ type: 'text' as const, text: formatRepairResult(result) }] };
        }
        fallbackEngine = new DBEngine({ dbPath, readOnly: false });
        await fallbackEngine.connect({ skipInitModel: true });
        const result = await fallbackEngine.repairTables();
        const text = formatRepairResult(result);
        return { content: [{ type: 'text' as const, text }] };
      } finally {
        await fallbackEngine?.disconnect();
        if (!retainRegistration) {
          await releaseAdmission?.();
          await release();
        }
      }
    })
  );
}
