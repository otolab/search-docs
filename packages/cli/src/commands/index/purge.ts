import { ConfigLoader } from '@search-docs/config';
import { assertPurgeSourcesOutsideIndex, clearIndexContents } from '@search-docs/server';
import { runPurgeTransaction } from '../../utils/purge-transaction.js';

export interface IndexPurgeOptions {
  config?: string;
  confirmIsolated?: boolean;
}

export async function executeIndexPurge(options: IndexPurgeOptions): Promise<void> {
  try {
    const { config, projectRoot } = await ConfigLoader.resolve({ cwd: process.cwd(), configPath: options.config, requireConfig: true });
    if (!config) throw new Error('設定ファイルが見つかりません');
    await runPurgeTransaction({
      projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath,
      confirmed: options.confirmIsolated === true,
      prepare: async layout => { await assertPurgeSourcesOutsideIndex({ projectRoot, indexPath: layout.indexPath, sources: config.files.sources }); },
      remove: async layout => { await clearIndexContents(layout.indexPath); },
    });
    console.log('インデックスを削除しました。');
  } catch (error) {
    console.error(`削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
