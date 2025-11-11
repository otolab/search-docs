/**
 * 設定ファイルの型定義
 */

export interface SearchDocsConfig {
  version: string;
  project: ProjectConfig;
  files: FilesConfig;
  indexing: IndexingConfig;
  search: SearchConfig;
  server: ServerConfig;
  storage: StorageConfig;
  worker: WorkerConfig;
  watcher: WatcherConfig;
}

export interface ProjectConfig {
  /** プロジェクト名 */
  name: string;
  /** プロジェクトルート */
  root: string;
}

export interface FilesConfig {
  /** 含めるファイルパターン（glob） */
  include: string[];
  /** 除外するファイルパターン（glob） */
  exclude: string[];
  /** .gitignoreを尊重するか */
  ignoreGitignore: boolean;
}

export interface IndexingConfig {
  /** セクションあたりの最大トークン数 */
  maxTokensPerSection: number;
  /** 分割の最小トークン数 */
  minTokensForSplit: number;
  /** 最大深度 */
  maxDepth: number;
  /** ベクトル次元数 */
  vectorDimension: number;
  /** 埋め込みモデル */
  embeddingModel: string;
}

export interface SearchConfig {
  /** デフォルトの結果数 */
  defaultLimit: number;
  /** 最大結果数 */
  maxLimit: number;
  /** Cleanな結果のみを含めるか */
  includeCleanOnly: boolean;
}

export interface ServerConfig {
  /** ホスト */
  host: string;
  /** ポート */
  port: number;
  /** プロトコル */
  protocol: 'json-rpc' | 'http';
}

export interface StorageConfig {
  /** 文書の保存パス */
  documentsPath: string;
  /** インデックスの保存パス */
  indexPath: string;
  /** キャッシュの保存パス */
  cachePath: string;
}

export interface WorkerConfig {
  /** ワーカーを有効にするか */
  enabled: boolean;
  /** 更新間隔（ミリ秒） */
  interval: number;
  /** 最大並行処理数 */
  maxConcurrent: number;
  /** ドキュメント処理後の待機時間（ミリ秒）。CPU・メモリ負荷を下げるために使用 */
  delayBetweenDocuments?: number;
  /** バッチ処理の最大トークン数。GPUメモリピークを制御（デフォルト: 4000） */
  maxBatchTokens?: number;
  /** Pythonワーカーの最大メモリ使用量（MB）。超過時に自動再起動 */
  pythonMaxMemoryMB?: number;
  /** メモリ監視の間隔（ミリ秒） */
  memoryCheckIntervalMs?: number;
}

export interface WatcherConfig {
  /** ファイル監視を有効にするか */
  enabled: boolean;
  /** デバウンス時間（ミリ秒） */
  debounceMs: number;
  /** ファイル書き込み完了の待機時間（ミリ秒） */
  awaitWriteFinishMs: number;
}

/** デフォルト設定 */
export const DEFAULT_CONFIG: SearchDocsConfig = {
  version: '1.0',
  project: {
    name: '',
    root: '.',
  },
  files: {
    include: ['**/*.md'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    ignoreGitignore: true,
  },
  indexing: {
    maxTokensPerSection: 2000,
    minTokensForSplit: 100,
    maxDepth: 3,
    vectorDimension: 256,
    embeddingModel: 'cl-nagoya/ruri-v3-30m',
  },
  search: {
    defaultLimit: 10,
    maxLimit: 100,
    includeCleanOnly: false,
  },
  server: {
    host: 'localhost',
    port: 24280,
    protocol: 'json-rpc',
  },
  storage: {
    documentsPath: '.search-docs/documents',
    indexPath: '.search-docs/index',
    cachePath: '.search-docs/cache',
  },
  worker: {
    enabled: true,
    interval: 5000,
    maxConcurrent: 3,
    delayBetweenDocuments: 0, // 待機なし（デフォルト）
    maxBatchTokens: 4000, // バッチ処理の最大トークン数（GPUメモリピーク制御）
    pythonMaxMemoryMB: 8192, // 8GB
    memoryCheckIntervalMs: 10000, // 10秒
  },
  watcher: {
    enabled: true,
    debounceMs: 300,
    awaitWriteFinishMs: 200,
  },
};
