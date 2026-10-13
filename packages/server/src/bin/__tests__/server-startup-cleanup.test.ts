import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../server.js';

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  embeddingServerConstructor: vi.fn(),
  readPidFile: vi.fn(),
  writePidFile: vi.fn(),
  deletePidFile: vi.fn(),
  isProcessAlive: vi.fn(),
  setupLogRedirect: vi.fn(),
}));

vi.mock('@search-docs/config', () => ({
  ConfigLoader: { resolve: mocks.resolveConfig },
}));
vi.mock('@search-docs/storage', () => ({
  FileStorage: vi.fn(),
}));
vi.mock('@search-docs/db-engine', () => ({
  DBEngine: vi.fn(),
}));
vi.mock('../../index.js', () => ({
  SearchDocsServer: vi.fn(),
  JsonRpcServer: vi.fn(),
  WatcherProcess: vi.fn(),
  EmbeddingServerProcess: mocks.embeddingServerConstructor,
}));
vi.mock('../../utils/pid.js', () => ({
  writePidFile: mocks.writePidFile,
  deletePidFile: mocks.deletePidFile,
  readPidFile: mocks.readPidFile,
  isProcessAlive: mocks.isProcessAlive,
}));
vi.mock('../../utils/log-redirect.js', () => ({
  setupLogRedirect: mocks.setupLogRedirect,
}));

describe('server startup cleanup', () => {
  const embeddingServer = {
    start: vi.fn(),
    stop: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.embeddingServerConstructor.mockImplementation(() => embeddingServer);
    embeddingServer.start.mockResolvedValue('http://localhost:24281');
    embeddingServer.stop.mockResolvedValue(undefined);
    mocks.resolveConfig.mockResolvedValue({
      config: {
        project: { name: 'test-project' },
        indexing: { embeddingUrl: undefined, vectorDimension: 256 },
        server: { host: '127.0.0.1', port: 24280 },
      },
      configPath: '/tmp/test-project/.search-docs.json',
      projectRoot: '/tmp/test-project',
    });
    mocks.readPidFile.mockResolvedValue({
      pid: 87654,
      port: 24280,
      startedAt: '2026-10-13T00:00:00.000Z',
    });
    mocks.isProcessAlive.mockReturnValue(true);
    mocks.deletePidFile.mockResolvedValue(undefined);
    mocks.writePidFile.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('stops the local embedding child when later server startup checks fail', async () => {
    const beforeSigintListeners = process.listenerCount('SIGINT');
    const beforeSigtermListeners = process.listenerCount('SIGTERM');

    await main();

    expect(embeddingServer.start).toHaveBeenCalledOnce();
    expect(embeddingServer.stop).toHaveBeenCalledOnce();
    expect(mocks.writePidFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigtermListeners);
  });
});
