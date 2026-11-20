import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@search-docs/types';

const capture = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock('@search-docs/server', () => ({
  resolveEmbeddingApiKey: () => undefined,
  EmbeddingServerProcess: class {
    constructor(options: unknown) { capture.options(options); }
    async start() { return 'http://embedding'; }
  },
  SearchDocsServer: class { setWatcherProcess() {} start() {} },
  WatcherProcess: class { start() {} },
}));
vi.mock('@search-docs/storage', () => ({ FileStorage: class {} }));
vi.mock('@search-docs/db-engine', () => ({ DBEngine: class {} }));

import { createService } from '../state.js';

afterEach(() => { vi.unstubAllEnvs(); capture.options.mockReset(); });

it('gives EMBEDDING_URL precedence and makes it required', async () => {
  vi.stubEnv('EMBEDDING_URL', 'http://explicit:11434');
  const config = structuredClone(DEFAULT_CONFIG);
  config.indexing.embeddingUrl = 'http://legacy:24281';
  await createService(config, '/tmp', 'test');
  expect(capture.options).toHaveBeenCalledWith(expect.objectContaining({
    embeddingUrl: 'http://explicit:11434', requireEmbeddingUrl: true,
  }));
});

it('retains fallback for the legacy config URL', async () => {
  vi.stubEnv('EMBEDDING_URL', '');
  const config = structuredClone(DEFAULT_CONFIG);
  config.indexing.embeddingUrl = 'http://legacy:24281';
  await createService(config, '/tmp', 'test');
  expect(capture.options).toHaveBeenCalledWith(expect.objectContaining({
    embeddingUrl: 'http://legacy:24281', requireEmbeddingUrl: false,
  }));
});
