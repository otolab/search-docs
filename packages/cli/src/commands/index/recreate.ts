import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ConfigLoader } from '@search-docs/config';
import { DBEngine, UnconfirmedProcessStopError, type DBEngineOptions } from '@search-docs/db-engine';
import { EmbeddingServerProcess, FileStorage, assertPurgeSourcesOutsideIndex, clearIndexContents, indexSynchronousSources, prepareSynchronousSources, prepareEmbeddingOptions } from '@search-docs/server';
import { runRebuildTransaction } from '../../utils/rebuild-transaction.js';

export async function executeIndexRecreate(options: { config?: string; confirmIsolated?: boolean }): Promise<void> {
  let embeddingServer: EmbeddingServerProcess | undefined;
  let completed = false;
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
        embeddingServer = new EmbeddingServerProcess({
          embedding, embeddingUrl: process.env.EMBEDDING_URL || config.indexing.embeddingUrl,
          requireEmbeddingUrl: Boolean(process.env.EMBEDDING_URL || (embedding?.provider === 'builtin' && embedding.url)),
          port: 24281, runtime: 'onnx', modelPath: process.env.SEARCH_DOCS_DOCKER_MODEL_PATH,
          dimension: config.indexing.vectorDimension,
        });
        const embeddingUrl = await embeddingServer.start();
        const engineOptions: DBEngineOptions = {
          embeddingUrl, embeddingOptions, embeddingDimension: config.indexing.vectorDimension,
          embeddingProvider: embedding?.provider,
          embeddingModel: embedding && 'model' in embedding ? embedding.model : undefined,
          maxBatchTokens: config.worker.maxBatchTokens,
        };
        const temporary = await mkdtemp(path.join(tmpdir(), 'search-docs-recreate-preflight-'));
        const probe = new DBEngine({ ...engineOptions, dbPath: temporary });
        void probe.waitForConnection().catch(() => {});
        let probeFailure: unknown;
        let probeFailed = false;
        try {
          await probe.connect();
          const result = await probe.initModel();
          if (!result.success || result.dimension !== config.indexing.vectorDimension) {
            throw new Error(`Embedding の次元が一致しません: ${result.dimension} (設定: ${config.indexing.vectorDimension})`);
          }
        } catch (error) { probeFailure = error; probeFailed = true; }
        try { await probe.disconnect(); } catch (error) { throw new UnconfirmedProcessStopError(error); }
        await rm(temporary, { recursive: true, force: true });
        if (probeFailed) throw probeFailure instanceof Error ? probeFailure : new Error('Embedding の初期化に失敗しました', { cause: probeFailure });
        return { prepared, engineOptions };
      },
      clear: async layout => { await clearIndexContents(layout.indexPath); },
      rebuild: async ({ prepared, engineOptions }, layout) => {
        const engine = new DBEngine({ ...engineOptions, dbPath: layout.indexPath });
        await indexSynchronousSources({ prepared, engine, storage: new FileStorage({ basePath: layout.documentsPath }), indexing: config.indexing });
      },
    });
    completed = true;
  } catch (error) {
    console.error(`再構築に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    try { await embeddingServer?.stop(); } catch (error) {
      console.error(`Embedding サーバーの停止に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  if (completed && process.exitCode !== 1) console.log('インデックスの再構築が完了しました。');
}
