import { MaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { validateRebuildLayout, type RebuildLayout } from './rebuild-layout.js';

/** 未公開の手順部品。呼び出し元は対象と非協調プロセスの停止を確認する必要がある。 */
export async function runRebuildTransaction<T>(options: {
  projectRoot: string;
  indexPath: string;
  documentsPath: string;
  confirmed: boolean;
  requireComplete?: boolean;
  prepare: (layout: RebuildLayout) => Promise<T>;
  clear: (layout: RebuildLayout) => Promise<void>;
  rebuild: (prepared: T, layout: RebuildLayout) => Promise<void>;
}): Promise<void> {
  if (!options.confirmed) throw new Error('インデックス専用領域であること、他ホストや旧版を含む全アクセスが停止していること、処理中にパスやマウントを変更しないことを確認してください');
  if (process.platform === 'win32') throw new Error('Windows では安全な再構築に必要な停止を確認できません');
  const layout = await validateRebuildLayout(options);
  const lease = await new MaintenanceLock(layout.managementPath).acquireExclusive({ requireComplete: options.requireComplete });
  let retainLock = false;
  try {
    const checked = await validateRebuildLayout(options);
    if (checked.indexPath !== layout.indexPath || checked.documentsPath !== layout.documentsPath || checked.managementPath !== layout.managementPath) {
      throw new Error('保存領域が検査後に変更されました');
    }
    const prepared = await options.prepare(checked);
    await lease.markIncomplete();
    await options.clear(checked);
    await options.rebuild(prepared, checked);
    await lease.complete();
  } catch (error) {
    if (error instanceof UnconfirmedProcessStopError) retainLock = true;
    throw error;
  } finally {
    if (!retainLock) await lease.release();
  }
}
