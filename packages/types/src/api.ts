/**
 * API Request/Response型定義
 */

import type { Document } from './document.js';

// ========================================
// Search API
// ========================================

export interface SearchRequest {
  query: string;
  options?: SearchOptions;
}

export interface SearchOptions {
  /** 深度指定（単一または配列） */
  depth?: number | number[];
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
  /** 除外するドキュメントパス（内部使用） */
  excludePaths?: string[];
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
  path: string;
}

export interface GetDocumentResponse {
  document: Document;
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
