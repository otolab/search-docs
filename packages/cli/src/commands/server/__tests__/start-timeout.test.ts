import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { startServer } from '../start.js';

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  readPidFile: vi.fn(),
  deletePidFile: vi.fn(),
  isProcessAlive: vi.fn(),
  isPortAvailable: vi.fn(),
  spawnServer: vi.fn(),
  waitForServerStart: vi.fn(),
}));

vi.mock('@search-docs/config', () => ({
  ConfigLoader: { resolve: mocks.resolveConfig },
}));
vi.mock('../../../utils/pid.js', () => ({
  readPidFile: mocks.readPidFile,
  deletePidFile: mocks.deletePidFile,
}));
vi.mock('../../../utils/process.js', () => ({
  isProcessAlive: mocks.isProcessAlive,
  isPortAvailable: mocks.isPortAvailable,
  spawnServer: mocks.spawnServer,
  waitForServerStart: mocks.waitForServerStart,
}));

describe('server start readiness timeout', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(path.join('/tmp', 'search-docs-start-timeout-'));
    mocks.resolveConfig.mockResolvedValue({
      config: {
        project: { name: 'test-project' },
        server: { host: '127.0.0.1', port: 34567 },
      },
      configPath: path.join(testDir, '.search-docs.json'),
      projectRoot: testDir,
    });
    mocks.readPidFile.mockResolvedValue(null);
    mocks.isPortAvailable.mockResolvedValue(true);
    mocks.waitForServerStart.mockResolvedValue(true);
    mocks.spawnServer.mockReturnValue({ pid: 12345, unref: vi.fn() });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  it('propagates the readiness budget and waits an additional startup grace', async () => {
    await startServer({
      readyTimeout: '42000',
      foreground: false,
      log: path.join(testDir, 'server.log'),
    });

    expect(mocks.spawnServer).toHaveBeenCalledWith(expect.objectContaining({
      embeddingReadyTimeoutMs: 42_000,
    }));
    expect(mocks.waitForServerStart).toHaveBeenCalledWith('127.0.0.1', 34567, 102_000);
  });
});
