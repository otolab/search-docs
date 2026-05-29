/**
 * maintenance repair コマンド
 * LanceDBテーブルの破損を検出・修復する（サーバ不要、DBEngine直接操作）
 */

import * as path from 'path';
import { ConfigLoader } from '@search-docs/config';
import { DBEngine, type RepairTablesResponse } from '@search-docs/db-engine';

export interface MaintenanceRepairOptions {
  config?: string;
}

function formatRepairResult(response: RepairTablesResponse): void {
  console.log('テーブル修復結果:');
  console.log('');

  for (const [tableName, result] of Object.entries(response.tables)) {
    const icon = result.status === 'ok' ? '✓' : '⚠';
    let line = `  ${icon} ${tableName}: ${result.status}`;
    if (result.action) {
      line += ` → ${result.action}`;
    }
    console.log(line);
    if (result.error) {
      console.log(`    エラー: ${result.error}`);
    }
  }

  console.log('');
  if (response.initTablesError) {
    console.error(`テーブル再初期化エラー: ${response.initTablesError}`);
  }

  if (response.createdCount) {
    console.log(`${response.createdCount}個のテーブルを新規作成しました。`);
  }

  if (response.repairedCount > 0) {
    console.log(`${response.repairedCount}個の破損テーブルを修復しました。`);
    console.log('インデックスデータが失われているため、再インデックスが必要です:');
    console.log('  search-docs index rebuild --force');
  } else if (!response.createdCount) {
    console.log('全テーブル正常です。修復の必要はありません。');
  }
}

export async function executeMaintenanceRepair(
  options: MaintenanceRepairOptions
): Promise<void> {
  try {
    const { config, projectRoot } = await ConfigLoader.resolve({
      cwd: process.cwd(),
      configPath: options.config,
    });

    if (!config) {
      console.error('設定ファイルが見つかりません。先に search-docs config init を実行してください。');
      process.exit(1);
    }

    const dbPath = path.resolve(projectRoot, config.storage.indexPath);
    console.log(`データベースパス: ${dbPath}`);
    console.log('テーブルの修復を開始します...');
    console.log('');

    const dbEngine = new DBEngine({
      dbPath,
      readOnly: false,
    });

    await dbEngine.connect({ skipInitModel: true });

    try {
      const result = await dbEngine.repairTables();
      formatRepairResult(result);
    } finally {
      dbEngine.disconnect();
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
