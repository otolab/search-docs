import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnServer } from '../process.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('spawnServer log path propagation', () => {
  it.each([
    { daemon: true, inherited: undefined, expected: '/custom.log' },
    { daemon: true, inherited: '/environment.log', expected: '/custom.log' },
    { daemon: false, inherited: undefined, expected: undefined },
    { daemon: false, inherited: '/environment.log', expected: '/environment.log' },
  ])('passes the correct log path in daemon=$daemon with inherited=$inherited', ({ daemon, inherited, expected }) => {
    vi.stubEnv('SEARCH_DOCS_LOG_PATH', inherited);
    spawnMock.mockReturnValue({ unref: vi.fn() });
    spawnServer({ serverScript: '/fake/server.js', daemon, logPath: '/custom.log' });
    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.SEARCH_DOCS_LOG_PATH).toBe(expected);
  });
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
