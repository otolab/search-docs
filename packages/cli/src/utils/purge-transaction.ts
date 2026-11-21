import { runRebuildTransaction } from './rebuild-transaction.js';
import type { RebuildLayout } from './rebuild-layout.js';

/** 未公開。削除対象に元文書がないこと等の検証は prepare が行う。 */
export async function runPurgeTransaction(options: {
  projectRoot: string;
  indexPath: string;
  documentsPath: string;
  confirmed: boolean;
  prepare: (layout: RebuildLayout) => Promise<void>;
  remove: (layout: RebuildLayout) => Promise<void>;
}): Promise<void> {
  await runRebuildTransaction({
    ...options,
    requireComplete: true,
    clear: options.remove,
    rebuild: async () => {},
  });
}
