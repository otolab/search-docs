import type { SearchDocsConfig } from '@search-docs/types';

/**
 * 設定オブジェクトをバリデーション
 */
export function validateConfig(config: unknown): Partial<SearchDocsConfig> {
  if (typeof config !== 'object' || config === null) {
    throw new Error('Config must be an object');
  }

  const cfg = config as Record<string, unknown>;

  // バージョンのチェック
  if (cfg.version !== undefined && typeof cfg.version !== 'string') {
    throw new Error('config.version must be a string');
  }

  // project設定のバリデーション
  if (cfg.project !== undefined) {
    validateProjectConfig(cfg.project);
  }

  // files設定のバリデーション
  if (cfg.files !== undefined) {
    validateFilesConfig(cfg.files);
  }

  // indexing設定のバリデーション
  if (cfg.indexing !== undefined) {
    validateIndexingConfig(cfg.indexing);
  }

  // search設定のバリデーション
  if (cfg.search !== undefined) {
    validateSearchConfig(cfg.search);
  }

  // server設定のバリデーション
  if (cfg.server !== undefined) {
    validateServerConfig(cfg.server);
  }

  // storage設定のバリデーション
  if (cfg.storage !== undefined) {
    validateStorageConfig(cfg.storage);
  }

  // worker設定のバリデーション
  if (cfg.worker !== undefined) {
    validateWorkerConfig(cfg.worker);
  }

  // watcher設定のバリデーション
  if (cfg.watcher !== undefined) {
    validateWatcherConfig(cfg.watcher);
  }

  return cfg as Partial<SearchDocsConfig>;
}

function validateProjectConfig(project: unknown): void {
  if (typeof project !== 'object' || project === null) {
    throw new Error('config.project must be an object');
  }

  const prj = project as Record<string, unknown>;

  if (prj.name !== undefined && typeof prj.name !== 'string') {
    throw new Error('config.project.name must be a string');
  }

  if (prj.root !== undefined && typeof prj.root !== 'string') {
    throw new Error('config.project.root must be a string');
  }
}

function validateFilesConfig(files: unknown): void {
  if (typeof files !== 'object' || files === null) {
    throw new Error('config.files must be an object');
  }

  const f = files as Record<string, unknown>;

  if (f.include !== undefined && !Array.isArray(f.include)) {
    throw new Error('config.files.include must be an array');
  }

  if (f.include !== undefined) {
    const include = f.include as unknown[];
    if (!include.every((item) => typeof item === 'string')) {
      throw new Error('config.files.include must be an array of strings');
    }
  }

  if (f.exclude !== undefined && !Array.isArray(f.exclude)) {
    throw new Error('config.files.exclude must be an array');
  }

  if (f.exclude !== undefined) {
    const exclude = f.exclude as unknown[];
    if (!exclude.every((item) => typeof item === 'string')) {
      throw new Error('config.files.exclude must be an array of strings');
    }
  }

  if (f.ignoreGitignore !== undefined && typeof f.ignoreGitignore !== 'boolean') {
    throw new Error('config.files.ignoreGitignore must be a boolean');
  }
}

function validateIndexingConfig(indexing: unknown): void {
  if (typeof indexing !== 'object' || indexing === null) {
    throw new Error('config.indexing must be an object');
  }

  const idx = indexing as Record<string, unknown>;

  if (idx.maxTokensPerSection !== undefined && typeof idx.maxTokensPerSection !== 'number') {
    throw new Error('config.indexing.maxTokensPerSection must be a number');
  }

  if (idx.maxTokensPerSection !== undefined && (idx.maxTokensPerSection) <= 0) {
    throw new Error('config.indexing.maxTokensPerSection must be positive');
  }

  if (idx.minTokensForSplit !== undefined && typeof idx.minTokensForSplit !== 'number') {
    throw new Error('config.indexing.minTokensForSplit must be a number');
  }

  if (idx.minTokensForSplit !== undefined && (idx.minTokensForSplit) <= 0) {
    throw new Error('config.indexing.minTokensForSplit must be positive');
  }

  if (idx.maxDepth !== undefined && typeof idx.maxDepth !== 'number') {
    throw new Error('config.indexing.maxDepth must be a number');
  }

  if (idx.maxDepth !== undefined) {
    const maxDepth = idx.maxDepth;
    if (maxDepth < 0 || maxDepth > 3) {
      throw new Error('config.indexing.maxDepth must be between 0 and 3');
    }
  }

  if (idx.vectorDimension !== undefined && typeof idx.vectorDimension !== 'number') {
    throw new Error('config.indexing.vectorDimension must be a number');
  }

  if (idx.vectorDimension !== undefined) {
    const dim = idx.vectorDimension;
    if (dim !== 256 && dim !== 768) {
      throw new Error('config.indexing.vectorDimension must be 256 or 768');
    }
  }

  if (idx.embeddingModel !== undefined && typeof idx.embeddingModel !== 'string') {
    throw new Error('config.indexing.embeddingModel must be a string');
  }
}

function validateSearchConfig(search: unknown): void {
  if (typeof search !== 'object' || search === null) {
    throw new Error('config.search must be an object');
  }

  const src = search as Record<string, unknown>;

  if (src.defaultLimit !== undefined && typeof src.defaultLimit !== 'number') {
    throw new Error('config.search.defaultLimit must be a number');
  }

  if (src.defaultLimit !== undefined && (src.defaultLimit) <= 0) {
    throw new Error('config.search.defaultLimit must be positive');
  }

  if (src.maxLimit !== undefined && typeof src.maxLimit !== 'number') {
    throw new Error('config.search.maxLimit must be a number');
  }

  if (src.maxLimit !== undefined && (src.maxLimit) <= 0) {
    throw new Error('config.search.maxLimit must be positive');
  }

  if (src.includeCleanOnly !== undefined && typeof src.includeCleanOnly !== 'boolean') {
    throw new Error('config.search.includeCleanOnly must be a boolean');
  }
}

function validateServerConfig(server: unknown): void {
  if (typeof server !== 'object' || server === null) {
    throw new Error('config.server must be an object');
  }

  const srv = server as Record<string, unknown>;

  if (srv.host !== undefined && typeof srv.host !== 'string') {
    throw new Error('config.server.host must be a string');
  }

  if (srv.port !== undefined && typeof srv.port !== 'number') {
    throw new Error('config.server.port must be a number');
  }

  if (srv.protocol !== undefined && srv.protocol !== 'json-rpc' && srv.protocol !== 'http') {
    throw new Error('config.server.protocol must be "json-rpc" or "http"');
  }
}

function validateStorageConfig(storage: unknown): void {
  if (typeof storage !== 'object' || storage === null) {
    throw new Error('config.storage must be an object');
  }

  const stg = storage as Record<string, unknown>;

  if (stg.documentsPath !== undefined && typeof stg.documentsPath !== 'string') {
    throw new Error('config.storage.documentsPath must be a string');
  }

  if (stg.indexPath !== undefined && typeof stg.indexPath !== 'string') {
    throw new Error('config.storage.indexPath must be a string');
  }

  if (stg.cachePath !== undefined && typeof stg.cachePath !== 'string') {
    throw new Error('config.storage.cachePath must be a string');
  }
}

function validateWorkerConfig(worker: unknown): void {
  if (typeof worker !== 'object' || worker === null) {
    throw new Error('config.worker must be an object');
  }

  const wrk = worker as Record<string, unknown>;

  if (wrk.enabled !== undefined && typeof wrk.enabled !== 'boolean') {
    throw new Error('config.worker.enabled must be a boolean');
  }

  if (wrk.interval !== undefined && typeof wrk.interval !== 'number') {
    throw new Error('config.worker.interval must be a number');
  }

  if (wrk.interval !== undefined && (wrk.interval) <= 0) {
    throw new Error('config.worker.interval must be positive');
  }

  if (wrk.maxConcurrent !== undefined && typeof wrk.maxConcurrent !== 'number') {
    throw new Error('config.worker.maxConcurrent must be a number');
  }

  if (wrk.maxConcurrent !== undefined && (wrk.maxConcurrent) <= 0) {
    throw new Error('config.worker.maxConcurrent must be positive');
  }
}

function validateWatcherConfig(watcher: unknown): void {
  if (typeof watcher !== 'object' || watcher === null) {
    throw new Error('config.watcher must be an object');
  }

  const wtc = watcher as Record<string, unknown>;

  if (wtc.enabled !== undefined && typeof wtc.enabled !== 'boolean') {
    throw new Error('config.watcher.enabled must be a boolean');
  }

  if (wtc.debounceMs !== undefined && typeof wtc.debounceMs !== 'number') {
    throw new Error('config.watcher.debounceMs must be a number');
  }

  if (wtc.debounceMs !== undefined && (wtc.debounceMs) < 0) {
    throw new Error('config.watcher.debounceMs must be non-negative');
  }

  if (wtc.awaitWriteFinishMs !== undefined && typeof wtc.awaitWriteFinishMs !== 'number') {
    throw new Error('config.watcher.awaitWriteFinishMs must be a number');
  }

  if (wtc.awaitWriteFinishMs !== undefined && (wtc.awaitWriteFinishMs) < 0) {
    throw new Error('config.watcher.awaitWriteFinishMs must be non-negative');
  }
}
