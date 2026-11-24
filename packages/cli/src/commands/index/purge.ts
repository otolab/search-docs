import { ConfigLoader } from '@search-docs/config';
import { DBEngine, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { assertPurgeSourcesOutsideIndex, clearIndexContents, EmbeddingServerProcess, prepareEmbeddingOptions } from '@search-docs/server';
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
      remove: async layout => {
        const embedding = new EmbeddingServerProcess({
          embedding: config.indexing.embedding,
          embeddingUrl: process.env.EMBEDDING_URL || config.indexing.embeddingUrl,
          requireEmbeddingUrl: Boolean(process.env.EMBEDDING_URL),
          port: 24281,
          runtime: 'onnx',
          modelPath: process.env.SEARCH_DOCS_DOCKER_MODEL_PATH,
          dimension: config.indexing.vectorDimension,
        });
        let engine: DBEngine | undefined;
        let failure: unknown;
        let failed = false;
        const errors: unknown[] = [];
        try {
          const embeddingUrl = await embedding.start();
          await clearIndexContents(layout.indexPath);
          engine = new DBEngine({
            dbPath: layout.indexPath,
            embeddingUrl,
            embeddingDimension: config.indexing.vectorDimension,
            embeddingOptions: prepareEmbeddingOptions(config.indexing.embedding),
            embeddingProvider: config.indexing.embedding?.provider,
            embeddingModel: config.indexing.embedding && 'model' in config.indexing.embedding ? config.indexing.embedding.model : undefined,
            maxBatchTokens: config.worker.maxBatchTokens,
            pythonMaxMemoryMB: config.worker.pythonMaxMemoryMB,
            memoryCheckIntervalMs: config.worker.memoryCheckIntervalMs,
          });
          await engine.connect();
        } catch (error) {
          failure = error;
          failed = true;
        } finally {
          if (engine) await engine.disconnect().catch(error => errors.push(error));
          await embedding.stop().catch(error => errors.push(error));
        }
        if (errors.length) throw new UnconfirmedProcessStopError(new AggregateError(failed ? [failure, ...errors] : errors, '保守プロセスの停止を確認できません'));
        if (failed) throw failure;
      },
    });
    console.log('インデックスを削除しました。');
  } catch (error) {
    console.error(`削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
