import * as path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { DBEngine, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { FileStorage } from '@search-docs/storage';
import type { SearchDocsConfig } from '@search-docs/types';
import { FileDiscovery } from './file-discovery.js';
import { assertDocumentKey, assertRelativePattern, assertSourcePath } from './strict-path.js';

export class StrictSafetyError extends Error {}

/** 呼び出し元は共有登録と admission を保持する。DB と文書を変更しない。 */
export async function diagnoseStrictConfig(config: SearchDocsConfig, options: { skipTable?: 'sections' | 'index_requests' | 'writer_heartbeat' } = {}): Promise<void> {
  const root = config.project.root;
  for (const pattern of [...config.files.sources, ...config.files.exclude]) assertRelativePattern(pattern);
  const storagePath = path.resolve(root, config.storage.documentsPath);
  const indexPath = path.resolve(root, config.storage.indexPath);
  const exists = async (file: string): Promise<boolean> => {
    try { await lstat(file); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const hasIndex = await exists(indexPath);
  const hasStorage = await exists(storagePath);
  if (hasIndex && !hasStorage) throw new Error('インデックスに対応する文書保存先がありません。データを変更せず確認してください');
  if (!hasIndex && hasStorage && (await readdir(storagePath)).length !== 0) {
    throw new Error('インデックスのない文書保存先が空ではありません。データを変更せず確認してください');
  }
  const discovery = new FileDiscovery({ rootDir: root, config: config.files });
  for (const key of await discovery.findFiles()) await assertSourcePath(root, key);
  if (!hasIndex) return;
  const storage = new FileStorage({ basePath: storagePath });
  const diagnostic = new DBEngine({ dbPath: indexPath, readOnly: true });
  try {
    await diagnostic.connect({ skipInitModel: true });
    if (options.skipTable !== 'writer_heartbeat') await diagnostic.getWriterHeartbeat();
    const keys = new Set([
      ...await storage.list({ strict: true }),
      ...(options.skipTable === 'sections' ? [] : await diagnostic.getIndexedPaths()),
      ...(options.skipTable === 'index_requests' ? [] : await diagnostic.getPathsWithStatus(['pending', 'processing'])),
    ]);
    for (const key of keys) {
      assertDocumentKey(key);
      await assertSourcePath(root, key);
      const document = await storage.get(key);
      if (document && document.path !== key) throw new Error(`文書コピーのキーが一致しません: ${key}`);
    }
  } finally {
    await diagnostic.disconnect().catch(error => { throw new UnconfirmedProcessStopError(error); });
  }
}
