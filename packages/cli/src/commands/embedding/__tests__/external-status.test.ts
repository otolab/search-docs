import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), probe: vi.fn() }));
vi.mock('@search-docs/config', () => ({ ConfigLoader: { resolve: mocks.resolve } }));
vi.mock('@search-docs/server', () => ({ startExternalEmbedding: mocks.probe }));
import { executeEmbeddingStatus } from '../status.js';

afterEach(() => { vi.resetAllMocks(); process.exitCode = undefined; });

it('uses the configured provider for status and reports failure', async () => {
  const embedding = { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test' };
  mocks.resolve.mockResolvedValue({ config: { indexing: { embedding, vectorDimension: 3 } } });
  mocks.probe.mockRejectedValue(new Error('Embedding provider returned HTTP 401'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await executeEmbeddingStatus({});
  expect(mocks.probe).toHaveBeenCalledWith(embedding, 3, 3000);
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith('Error:', 'Embedding provider returned HTTP 401');
  error.mockRestore();
});
