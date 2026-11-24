/**
 * maintenance repair コマンド
 * LanceDBテーブルの破損を検出・修復する（サーバ不要、DBEngine直接操作）
 */

import * as path from 'path';
import { ConfigLoader } from '@search-docs/config';
import { DBEngine, strictMaintenanceLock, UnconfirmedProcessStopError, type RepairTablesResponse } from '@search-docs/db-engine';
import { diagnoseStrictConfig } from '@search-docs/server';

export interface MaintenanceRepairOptions {
  config?: string;
}

function formatRepairResult(response: RepairTablesResponse): void {
  console.log('テーブル修復結果:');
  console.log('');
  let unreadable = false;

  for (const [tableName, result] of Object.entries(response.tables)) {
    const icon = result.status === 'ok' ? '✓' : '⚠';
    let line = `  ${icon} ${tableName}: ${result.status}`;
    if (result.action) {
      line += ` → ${result.action}`;
    }
    console.log(line);
    if (result.error) {
      unreadable = true;
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

  if (unreadable) {
    console.log('テーブルを変更していません。バックアップし、maintenance force-repair の手順を確認してください。');
  } else if (response.repairedCount > 0) {
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

    const lock = await strictMaintenanceLock({
      projectRoot,
      indexPath: config.storage.indexPath,
      documentsPath: config.storage.documentsPath,
      files: config.files,
    });
    const release = await lock.acquireShared();
    let releaseAdmission: (() => Promise<void>) | undefined;
    let retainRegistration = false;
    const dbEngine = new DBEngine({
      dbPath,
      readOnly: false,
    });

    try {
      releaseAdmission = await lock.acquireAdmission();
      try {
        await diagnoseStrictConfig(config);
      } catch (error) {
        if (error instanceof UnconfirmedProcessStopError) retainRegistration = true;
        throw new Error(`修復前の診断に失敗しました: ${String(error)}。全プロセスを停止し、データをバックアップして、設定と保存先を確認してください。読めないテーブルが残っている場合は maintenance force-repair のプレビューを確認し、対象が欠損している場合などはバックアップからの復旧を検討してください。`);
      }
      await dbEngine.connect({ skipInitModel: true });
      const result = await dbEngine.repairTables();
      formatRepairResult(result);
    } finally {
      await dbEngine.disconnect();
      if (!retainRegistration) {
        await releaseAdmission?.();
        await release();
      }
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
