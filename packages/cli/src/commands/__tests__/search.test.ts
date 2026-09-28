import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResponse } from '@search-docs/types';
import { executeSearch } from '../search.js';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  SearchDocsClient: vi.fn(),
  resolveServerUrl: vi.fn(),
  formatSearchResultsAsJson: vi.fn(() => 'json output'),
  formatSearchResultsAsText: vi.fn(() => 'text output'),
}));

vi.mock('@search-docs/client', () => ({
  SearchDocsClient: mocks.SearchDocsClient,
  JsonRpcClientError: class JsonRpcClientError extends Error {},
}));

vi.mock('../../utils/server-url.js', () => ({
  resolveServerUrl: mocks.resolveServerUrl,
}));

vi.mock('../../utils/output.js', () => ({
  formatSearchResultsAsJson: mocks.formatSearchResultsAsJson,
  formatSearchResultsAsText: mocks.formatSearchResultsAsText,
}));

const response: SearchResponse = {
  results: [],
  total: 0,
  took: 1,
};

describe('executeSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.SearchDocsClient.mockImplementation(function SearchDocsClientMock() {
      return { search: mocks.search };
    });
    mocks.resolveServerUrl.mockResolvedValue('http://127.0.0.1:24280');
    mocks.search.mockResolvedValue(response);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes repeated path filters to the search request and preview lines to the text renderer', async () => {
    await executeSearch('API設計', {
      server: 'http://localhost:24280',
      limit: '20',
      depth: '2',
      cleanOnly: true,
      includePath: ['docs/', 'README.md'],
      excludePath: ['docs/internal/'],
      previewLines: '2',
    });

    expect(mocks.SearchDocsClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:24280',
    });
    expect(mocks.search).toHaveBeenCalledWith({
      query: 'API設計',
      options: {
        limit: 20,
        depth: 2,
        includeCleanOnly: true,
        includePaths: ['docs/', 'README.md'],
        excludePaths: ['docs/internal/'],
      },
    });
    expect(mocks.formatSearchResultsAsText).toHaveBeenCalledWith(response, {
      hints: 'cli',
      previewLines: 2,
    });
    expect(mocks.formatSearchResultsAsJson).not.toHaveBeenCalled();
  });

  it('keeps JSON output as the raw search response without renderer options', async () => {
    await executeSearch('API設計', {
      format: 'json',
      previewLines: '2',
    });

    expect(mocks.search).toHaveBeenCalledWith({
      query: 'API設計',
      options: {
        limit: 10,
        depth: undefined,
        includeCleanOnly: false,
      },
    });
    expect(mocks.formatSearchResultsAsJson).toHaveBeenCalledWith(response);
    expect(mocks.formatSearchResultsAsText).not.toHaveBeenCalled();
  });
});
