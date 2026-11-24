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
  acquireRegistration: vi.fn(),
  releaseRegistration: vi.fn(),
  strictMaintenanceLock: vi.fn(),
  acquireAdmission: vi.fn(),
  releaseAdmission: vi.fn(),
  diagnoseStrictConfig: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: mocks.mkdir,
}));
vi.mock('@search-docs/config', () => ({
  ConfigLoader: { resolve: mocks.resolveConfig },
}));
vi.mock('@search-docs/storage', () => ({
  FileStorage: vi.fn(),
}));
vi.mock('@search-docs/db-engine', () => ({
  DBEngine: vi.fn(),
  strictMaintenanceLock: mocks.strictMaintenanceLock,
  UnconfirmedProcessStopError: class extends Error {},
}));
vi.mock('../../index.js', () => ({
  SearchDocsServer: vi.fn(),
  JsonRpcServer: vi.fn(),
  WatcherProcess: vi.fn(),
  EmbeddingServerProcess: mocks.embeddingServerConstructor,
  diagnoseStrictConfig: mocks.diagnoseStrictConfig,
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
    mocks.embeddingServerConstructor.mockImplementation(function () { return embeddingServer; });
    embeddingServer.start.mockResolvedValue('http://localhost:24281');
    embeddingServer.stop.mockResolvedValue(undefined);
    mocks.acquireRegistration.mockResolvedValue(mocks.releaseRegistration);
    mocks.releaseRegistration.mockResolvedValue(undefined);
    mocks.strictMaintenanceLock.mockResolvedValue({
      acquireShared: mocks.acquireRegistration,
      acquireAdmission: mocks.acquireAdmission,
    });
    mocks.acquireAdmission.mockResolvedValue(mocks.releaseAdmission);
    mocks.releaseAdmission.mockResolvedValue(undefined);
    mocks.diagnoseStrictConfig.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.resolveConfig.mockResolvedValue({
      config: {
        project: { name: 'test-project' },
        indexing: { embeddingUrl: undefined, vectorDimension: 256 },
        server: { host: '127.0.0.1', port: 24280 },
        storage: { indexPath: '.search-docs/index', documentsPath: '.search-docs/documents' },
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
    expect(mocks.releaseAdmission).toHaveBeenCalledOnce();
    expect(mocks.releaseRegistration).toHaveBeenCalledOnce();
    expect(mocks.writePidFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigtermListeners);
  });

  it('retains registration when startup cleanup fails', async () => {
    embeddingServer.stop.mockRejectedValue(new Error('stop failed'));
    await main();
    expect(embeddingServer.start).toHaveBeenCalledOnce();
    expect(embeddingServer.stop).toHaveBeenCalledOnce();
    expect(mocks.acquireRegistration).toHaveBeenCalledOnce();
    expect(mocks.releaseAdmission).not.toHaveBeenCalled();
    expect(mocks.releaseRegistration).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
