import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkEmbeddingHealth,
  checkEmbeddingReadiness,
  probeEmbedding,
} from '../embedding.js';

function response(status: number, body: unknown) {
  return {
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedding HTTP probes', () => {
  it('accepts degraded health as liveness while exposing readiness fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      status: 'degraded',
      model: 'ruri',
      vectorDimension: 3,
      ready: false,
      consecutiveFailures: 2,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkEmbeddingHealth('127.0.0.1', 24281);

    expect(result?.status).toBe('degraded');
    expect(result?.ready).toBe(false);
    expect(result?.consecutiveFailures).toBe(2);
  });

  it('falls back from /ready to legacy /health', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { error: 'Not found' }))
      .mockResolvedValueOnce(response(200, {
        status: 'ok',
        model: 'ruri',
        vectorDimension: 3,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkEmbeddingReadiness('127.0.0.1', 24281);

    expect(result?.ready).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:24281/ready');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:24281/health');
  });

  it('probes /encode when an older server does not expose /api/embed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { error: 'Not found' }))
      .mockResolvedValueOnce(response(200, { vectors: [[0.1, 0.2, 0.3]] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeEmbedding('127.0.0.1', 24281, 1000, 3);

    expect(result).toMatchObject({
      success: true,
      endpoint: '/encode',
      vectorDimension: 3,
    });
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:24281/encode');
  });
});

