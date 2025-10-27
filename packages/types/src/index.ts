/**
 * @search-docs/types
 * search-docsの共通型定義
 */

// Document
export type { Document, DocumentMetadata } from './document.js';

// Section
export type { Section, SectionMetadata } from './section.js';

// Config
export type {
  SearchDocsConfig,
  ProjectConfig,
  FilesConfig,
  IndexingConfig,
  SearchConfig,
  ServerConfig,
  StorageConfig,
  WorkerConfig,
} from './config.js';
export { DEFAULT_CONFIG } from './config.js';

// API
export type {
  SearchRequest,
  SearchOptions,
  SearchResult,
  SearchResponse,
  GetDocumentRequest,
  GetDocumentResponse,
  IndexDocumentRequest,
  IndexDocumentResponse,
  GetStatusResponse,
  RebuildIndexRequest,
  RebuildIndexResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from './api.js';

// Storage
export type { DocumentStorage } from './storage.js';
