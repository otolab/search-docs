/**
 * API Request/Response型定義
 */

import type { Document } from './document.js';
import type { Section } from './section.js';

// ========================================
// Search API
// ========================================

export interface SearchRequest {
  query: string;
  options?: SearchOptions;
}

export interface SearchOptions {
  /** 最大深度（0-3: この深度まで検索。0=文書全体のみ、1=章まで、2=節まで、3=項まで） */
  depth?: number;
  /** 結果数 */
  limit?: number;
  /** オフセット */
  offset?: number;
  /** Cleanな結果のみ */
  includeCleanOnly?: boolean;
  /** ソート基準 */
  sortBy?: 'score' | 'depth' | 'path';
  /** インデックス状態フィルタ */
  indexStatus?: 'all' | 'latest_only' | 'completed_only';
  /** 包含するドキュメントパス（前方一致）例: ['docs/', 'README.md'] */
  includePaths?: string[];
  /** 除外するドキュメントパス（前方一致）例: ['docs/internal/', 'temp/'] */
  excludePaths?: string[];
  /** プレビュー行数（デフォルト: 5） */
  previewLines?: number;
}

export interface SearchResult {
  id: string;
  documentPath: string;
  documentHash: string;
  heading: string;
  depth: number;
  content: string;
  score: number;
  isDirty: boolean;
  tokenCount: number;
  /** インデックス状態 */
  indexStatus?: 'latest' | 'outdated' | 'updating';
  /** 最新のインデックスかどうか */
  isLatest?: boolean;
  /** 更新待ちリクエストがあるか */
  hasPendingUpdate?: boolean;
  /** セクション開始行（1-indexed） */
  startLine: number;
  /** セクション終了行（1-indexed） */
  endLine: number;
  /** 階層的なセクション番号（例: [1], [1, 2], [1, 2, 1]） */
  sectionNumber: number[];
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number; // ms
}

// ========================================
// GetDocument API
// ========================================

export interface GetDocumentRequest {
  /** 文書パス（sectionIdを指定しない場合は必須） */
  path?: string;
  /** セクションID（pathを指定しない場合は必須） */
  sectionId?: string;
}

export interface GetDocumentResponse {
  document: Document | null;
  /** セクション（sectionId指定時のみ） */
  section?: Section;
}

// ========================================
// IndexDocument API
// ========================================

export interface IndexDocumentRequest {
  path: string;
  force?: boolean;
}

export interface IndexDocumentResponse {
  success: boolean;
  sectionsCreated: number;
}

// ========================================
// GetStatus API
// ========================================

export interface GetStatusResponse {
  server: {
    version: string;
    uptime: number; // ms
    pid: number;
    /** 初期インデックス同期中かどうか */
    syncing: boolean;
    requests: {
      total: number;
      search: number;
      getDocument: number;
      indexDocument: number;
      rebuildIndex: number;
    };
  };
  index: {
    totalDocuments: number;
    totalSections: number;
    dirtyCount: number;
  };
  worker: {
    running: boolean;
    processing: number;
    queue: number;
  };
}

// ========================================
// RebuildIndex API
// ========================================

export interface RebuildIndexRequest {
  paths?: string[];
  force?: boolean;
}

export interface RebuildIndexResponse {
  success: boolean;
  documentsProcessed: number;
  sectionsCreated: number;
}

// ========================================
// JSON-RPC Types
// ========================================

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
