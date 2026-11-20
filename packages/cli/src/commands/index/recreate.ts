import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigLoader } from '@search-docs/config';
import { DBEngine } from '@search-docs/db-engine';
import { FileStorage, assertPurgeSourcesOutsideIndex, clearIndexContents, indexSynchronousSources, prepareSynchronousSources, prepareEmbeddingOptions, startExternalEmbedding } from '@search-docs/server';
import { runRebuildTransaction } from '../../utils/rebuild-transaction.js';

export async function executeIndexRecreate(options: { config?: string; confirmIsolated?: boolean }): Promise<void> {
  try {
    const { config, projectRoot } = await ConfigLoader.resolve({ cwd: process.cwd(), configPath: options.config, requireConfig: true });
    if (!config) throw new Error('設定ファイルが見つかりません');
    await runRebuildTransaction({
      projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath,
      confirmed: options.confirmIsolated === true,
      prepare: async layout => {
        await assertPurgeSourcesOutsideIndex({ projectRoot, indexPath: layout.indexPath, sources: config.files.sources });
        const prepared = await prepareSynchronousSources({ root: projectRoot, files: config.files, forbiddenPath: layout.indexPath });
        for (const source of prepared.sources) {
          const actual = await realpath(path.resolve(prepared.root, source.path));
          const relative = path.relative(layout.documentsPath, actual);
          if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
            throw new Error(`元文書が文書コピーの保存領域にあります: ${source.path}。削除せず、管理者に相談してください。`);
          }
        }
        const embedding = config.indexing.embedding;
        const embeddingOptions = prepareEmbeddingOptions(embedding);
        const embeddingUrl = embedding && embedding.provider !== 'builtin'
          ? await startExternalEmbedding(embedding, config.indexing.vectorDimension)
          : (embedding?.url ?? process.env.EMBEDDING_URL ?? config.indexing.embeddingUrl);
        return { prepared, embeddingUrl, embeddingOptions };
      },
      clear: async layout => { await clearIndexContents(layout.indexPath); },
      rebuild: async ({ prepared, embeddingUrl, embeddingOptions }, layout) => {
        const embedding = config.indexing.embedding;
        const engine = new DBEngine({
          dbPath: layout.indexPath, embeddingUrl, embeddingOptions,
          embeddingDimension: config.indexing.vectorDimension,
          embeddingProvider: embedding?.provider,
          embeddingModel: embedding && 'model' in embedding ? embedding.model : undefined,
          maxBatchTokens: config.worker.maxBatchTokens,
        });
        await indexSynchronousSources({ prepared, engine, storage: new FileStorage({ basePath: layout.documentsPath }), indexing: config.indexing });
      },
    });
    console.log('インデックスの再構築が完了しました。');
  } catch (error) {
    console.error(`再構築に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
