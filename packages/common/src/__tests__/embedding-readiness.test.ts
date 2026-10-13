import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMBEDDING_READY_TIMEOUT_MS,
  getEmbeddingReadyTimeoutMs,
} from '../embedding-readiness.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getEmbeddingReadyTimeoutMs', () => {
  it('uses a ten-minute default', () => {
    expect(getEmbeddingReadyTimeoutMs(undefined, null)).toBe(DEFAULT_EMBEDDING_READY_TIMEOUT_MS);
    expect(DEFAULT_EMBEDDING_READY_TIMEOUT_MS).toBe(600_000);
  });

  it('prefers an explicit option over the environment', () => {
    expect(getEmbeddingReadyTimeoutMs('12000', '9000')).toBe(12_000);
  });

  it('reads the shared environment variable', () => {
    vi.stubEnv('SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS', '45000');
    expect(getEmbeddingReadyTimeoutMs()).toBe(45_000);
  });

  it.each(['0', '-1', '1.5', 'not-a-number', '9007199254740992'])(
    'rejects invalid timeout %s',
    (value) => {
    expect(() => getEmbeddingReadyTimeoutMs(value, null)).toThrow(
        'positive integer in milliseconds',
      );
    },
  );
});
