/**
 * @search-docs/types
 * search-docsの共通型定義
 */

// Document
export type { Document, DocumentMetadata } from './document.js';

// Section
export type { Section } from './section.js';

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
  WatcherConfig,
  RelatedProjectConfig,
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
  GetOutlineRequest,
  GetOutlineResponse,
  OutlineItem,
  IndexDocumentRequest,
  IndexDocumentResponse,
  GetStatusResponse,
  RebuildIndexRequest,
  RebuildIndexResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from './api.js';

// Service
export type { SearchDocsService } from './service.js';

// Storage
export type { DocumentStorage } from './storage.js';

// PID
export type { PidFileContent } from './pid.js';
export { getPidFilePath } from './pid.js';
