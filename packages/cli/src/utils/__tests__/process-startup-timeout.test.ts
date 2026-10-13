import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnServer } from '../process.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('spawnServer embedding timeout propagation', () => {
  it('passes the configured readiness timeout to the server process environment', () => {
    spawnMock.mockReturnValue({ unref: vi.fn() });

    spawnServer({
      serverScript: '/fake/server.js',
      daemon: false,
      projectRoot: '/tmp/project',
      embeddingReadyTimeoutMs: 72_000,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['/fake/server.js'],
      expect.objectContaining({
        env: expect.objectContaining({
          SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS: '72000',
        }),
      }),
    );
  });
});
