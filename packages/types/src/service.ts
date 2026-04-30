import type {
  SearchRequest,
  SearchResponse,
  GetDocumentRequest,
  GetDocumentResponse,
  GetOutlineRequest,
  GetOutlineResponse,
  GetStatusResponse,
} from './api.js';

export interface SearchDocsService {
  search(request: SearchRequest): Promise<SearchResponse>;
  getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse>;
  getOutline(request: GetOutlineRequest): Promise<GetOutlineResponse>;
  getStatus(): Promise<GetStatusResponse>;
}
