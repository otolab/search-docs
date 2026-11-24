import { z } from 'zod';
import { validateRebuildLayout } from '@search-docs/cli/utils/rebuild-layout';
import { assertPurgeSourcesOutsideIndex, clearIndexContents, EmbeddingServerProcess, prepareEmbeddingOptions } from '@search-docs/server';
import { DBEngine, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { exclusivePurge } from '../maintenance/exclusive-purge.js';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

export function registerIndexPurgeTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;
  return server.registerTool('index_purge', {
    description: 'インデックスを削除します。対象が専用領域であり、他ホスト・旧版を含む全アクセスが停止し、処理中パスやマウントを変更しないことを確認してください。',
    inputSchema: { confirmIsolated: z.boolean().describe('上記の条件を利用者が確認した場合のみ true') },
  }, async ({ confirmIsolated }) => {
    if (systemState.state === 'NOT_CONFIGURED' || !systemState.config) throw new Error(getStateErrorMessage(systemState.state, 'インデックス削除'));
    if (!confirmIsolated) throw new Error('専用領域、全アクセスの停止、処理中のパス不変更を確認してください');
    if (!context.runMaintenance) throw new Error('安全な保守処理を利用できません');
    const config = systemState.config;
    const projectRoot = systemState.projectRoot;
    const validate = async () => {
      const layout = await validateRebuildLayout({ projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath });
      await assertPurgeSourcesOutsideIndex({ projectRoot, indexPath: layout.indexPath, sources: config.files.sources });
      return layout;
    };
    await validate();
    await context.runMaintenance(() => exclusivePurge({
      confirmed: confirmIsolated,
      validate,
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
          // 排他と未完了マーカーを保持したまま通常のモデル初期化で空の DB を作る。
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
    }));
    return { content: [{ type: 'text' as const, text: 'インデックスを削除し、サービスを再開しました。' }] };
  });
}
