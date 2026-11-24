import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigLoader } from '@search-docs/config';
import { DBEngine, strictMaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { assertPurgeSourcesOutsideIndex, diagnoseStrictConfig } from '@search-docs/server';
import { validateRebuildLayout } from '../../utils/rebuild-layout.js';

const tables = ['sections', 'index_requests', 'writer_heartbeat'] as const;
type Table = typeof tables[number];

export interface ForceRepairOptions {
  config?: string;
  table: string;
  confirm?: string;
  backup?: boolean;
  isolated?: boolean;
}

/** プレビューと実行はいずれも排他中に対象を検証する。 */
export async function executeForceRepair(options: ForceRepairOptions): Promise<void> {
  if (!tables.includes(options.table as Table)) throw new Error('対象テーブルを sections、index_requests、writer_heartbeat から指定してください');
  const table = options.table as Table;
  if (options.confirm && (!options.backup || !options.isolated)) throw new Error('バックアップと全アクセス停止・専用領域の確認が必要です');
  const { config, projectRoot } = await ConfigLoader.resolve({ cwd: process.cwd(), configPath: options.config });
  if (!config) throw new Error('設定が見つかりません');
  const lock = await strictMaintenanceLock({ projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath, files: config.files });
  const layout = await validateRebuildLayout({ projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath });
  const lease = await lock.acquireExclusive({ requireComplete: true });
  let retainLock = false;
  let incomplete = false;
  try {
    const checked = await validateRebuildLayout({ projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath });
    if (JSON.stringify(checked) !== JSON.stringify(layout)) throw new Error('保存先が検査後に変わりました');
    await assertPurgeSourcesOutsideIndex({ projectRoot, indexPath: checked.indexPath, sources: config.files.sources });
    const actualRoot = await realpath(projectRoot);
    const target = path.join(checked.indexPath, `${table}.lance`);
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('対象テーブルが通常のディレクトリではありません');
    await diagnoseStrictConfig(config, { skipTable: table });
    const diagnostic = new DBEngine({ dbPath: checked.indexPath, readOnly: true });
    let selectedError = '';
    try {
      await diagnostic.connect({ skipInitModel: true });
      for (const name of tables) {
        const result = await diagnostic.probeRepairTable(name);
        if (name === table) {
          if (result.readable) throw new Error(`指定テーブル ${name} は読み取れます`);
          selectedError = result.error ?? '詳細不明';
        } else if (!result.readable) {
          throw new Error(`指定外のテーブル ${name} も読み取れません: ${result.error}`);
        }
      }
      if (table === 'sections') await diagnostic.checkRepairDimension(config.indexing.vectorDimension);
    } finally {
      await diagnostic.disconnect().catch(error => { retainLock = true; throw error; });
    }
    const confirmation = createHash('sha256').update(JSON.stringify({ actualRoot, layout: checked, config, table, device: targetStat.dev, inode: targetStat.ino })).digest('hex');
    if (!options.confirm) {
      console.log(`対象: ${checked.indexPath} / ${table}\n読み取りエラー: ${selectedError}\nこのテーブルの全行が失われます。一時的な読み取り障害の可能性があります。読めないキーの安全性は確認できません。\n全 server・旧版・直接アクセスを停止し、index と documents をバックアップしてください。非協調プロセスの停止とバックアップの存在は自動確認できません。\n実行時は --confirm ${confirmation} --backup --isolated を指定してください。`);
      return;
    }
    if (options.confirm !== confirmation) throw new Error('プレビュー後に対象または設定が変わりました。再度プレビューしてください');
    incomplete = true;
    await lease.markIncomplete();
    const writable = new DBEngine({ dbPath: checked.indexPath, readOnly: false });
    try {
      await writable.connect({ skipInitModel: true });
      await writable.recreateRepairTable(table, config.indexing.vectorDimension);
    } finally {
      await writable.disconnect().catch(error => { retainLock = true; throw error; });
    }
    await diagnoseStrictConfig(config);
    await lease.complete();
    incomplete = false;
    console.log(`${table} を再作成し、通常診断に合格しました。必要に応じて再インデックスしてください。`);
  } catch (error) {
    if (incomplete || error instanceof UnconfirmedProcessStopError) retainLock = true;
    throw error;
  } finally {
    if (!retainLock) await lease.release();
  }
}
