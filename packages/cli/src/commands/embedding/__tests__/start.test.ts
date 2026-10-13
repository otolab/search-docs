import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingServer } from '../start.js';
import { stopEmbeddingServer } from '../stop.js';
import { showEmbeddingStatus } from '../status.js';

const childMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  openSync: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));
const embeddingMocks = vi.hoisted(() => ({
  readEmbeddingPidFile: vi.fn(),
  findEmbeddingHealth: vi.fn(),
  waitForEmbeddingReady: vi.fn(),
  isPortAvailable: vi.fn(),
  removeEmbeddingPidFile: vi.fn(),
  verifyEmbeddingStopped: vi.fn(),
  embeddingDir: vi.fn(),
  embeddingPidPath: vi.fn(),
  embeddingLogPath: vi.fn(),
}));
const processMocks = vi.hoisted(() => ({
  getListeningProcess: vi.fn(),
  isProcessAlive: vi.fn(),
  killProcess: vi.fn(),
  killProcessTree: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
  evaluateEmbeddingStatus: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: childMocks.spawn };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, closeSync: fsMocks.closeSync, openSync: fsMocks.openSync };
});
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdir: fsMocks.mkdir,
    unlink: fsMocks.unlink,
    writeFile: fsMocks.writeFile,
  };
});
vi.mock('../../../utils/embedding.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/embedding.js')>('../../../utils/embedding.js');
  return { ...actual, ...embeddingMocks };
});
vi.mock('../../../utils/process.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/process.js')>('../../../utils/process.js');
  return { ...actual, ...processMocks };
});
vi.mock('../../../utils/embedding-state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/embedding-state.js')>('../../../utils/embedding-state.js');
  return { ...actual, ...stateMocks };
});

const pid = 7001;
const launcherPid = 7000;
const port = 24281;

function health() {
  return {
    status: 'ok',
    model: 'ruri-v3',
    vectorDimension: 3,
    ready: true,
  };
}

function statusSnapshot(pidFile: { pid: number; port: number; startedAt: string }) {
  return {
    overallState: 'healthy' as const,
    host: '127.0.0.1',
    port,
    pidFile: { exists: true, value: pidFile },
    pidAlive: true,
    portListening: true,
    portOwner: { pid, command: 'embedding_server.py' },
    health: health(),
    readiness: { ready: true, statusCode: 200, latencyMs: 1 },
    embedProbe: null,
    checks: [],
    suggestions: [],
    startupGraceMs: 120000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  let storedPidFile: { pid: number; port: number; startedAt: string } | null = null;

  embeddingMocks.readEmbeddingPidFile.mockImplementation(async () => storedPidFile
    ? { exists: true, value: storedPidFile }
    : { exists: false, value: null });
  embeddingMocks.findEmbeddingHealth
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ host: '127.0.0.1', health: health() });
  embeddingMocks.waitForEmbeddingReady.mockResolvedValue(true);
  embeddingMocks.isPortAvailable.mockResolvedValue(true);
  embeddingMocks.removeEmbeddingPidFile.mockResolvedValue(undefined);
  embeddingMocks.verifyEmbeddingStopped.mockResolvedValue({
    processExited: true,
    portReleased: true,
    healthUnreachable: true,
  });
  embeddingMocks.embeddingDir.mockReturnValue('/tmp/search-docs-embedding');
  embeddingMocks.embeddingPidPath.mockReturnValue('/tmp/search-docs-embedding/embedding.pid');
  embeddingMocks.embeddingLogPath.mockReturnValue('/tmp/search-docs-embedding/embedding.log');
  fsMocks.openSync.mockReturnValue(42);
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.unlink.mockResolvedValue(undefined);
  fsMocks.writeFile.mockImplementation(async (_path: string, content: string) => {
    storedPidFile = JSON.parse(content) as typeof storedPidFile;
  });
  childMocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), {
    pid: launcherPid,
    exitCode: null,
    signalCode: null,
    unref: vi.fn(),
  }));
  processMocks.getListeningProcess.mockReturnValue({ pid, command: 'embedding_server.py' });
  processMocks.isProcessAlive.mockReturnValue(true);
  processMocks.killProcess.mockResolvedValue(undefined);
  processMocks.killProcessTree.mockResolvedValue(undefined);
  stateMocks.evaluateEmbeddingStatus.mockImplementation(async ({ pidFile }) =>
    statusSnapshot(pidFile.value));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('embedding lifecycle', () => {
  it('reaps descendants after a foreground launcher exits', async () => {
    const startPromise = startEmbeddingServer({
      port,
      dimension: 3,
      foreground: true,
    });
    await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalledOnce());
    const child = childMocks.spawn.mock.results[0].value as EventEmitter;
    child.emit('exit', 0, null);

    await startPromise;

    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
  });

  it('passes an explicit readiness timeout to the readiness wait', async () => {
    await startEmbeddingServer({ port, dimension: 3, readyTimeout: '45000' });

    expect(embeddingMocks.waitForEmbeddingReady).toHaveBeenCalledWith(
      '127.0.0.1',
      port,
      45000,
      expect.any(AbortSignal),
    );
  });

  it('uses the shared timeout environment variable', async () => {
    vi.stubEnv('SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS', '31000');
    await startEmbeddingServer({ port, dimension: 3 });

    expect(embeddingMocks.waitForEmbeddingReady).toHaveBeenCalledWith(
      '127.0.0.1',
      port,
      31000,
      expect.any(AbortSignal),
    );
  });

  it('reaps the detached process tree when readiness times out', async () => {
    embeddingMocks.waitForEmbeddingReady.mockResolvedValue(false);

    await expect(startEmbeddingServer({ port, dimension: 3, readyTimeout: 1000 }))
      .rejects.toThrow('did not become ready within 1000ms');

    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it('reaps the detached process tree when readiness checking fails', async () => {
    embeddingMocks.waitForEmbeddingReady.mockRejectedValue(new Error('readiness probe failed'));

    await expect(startEmbeddingServer({ port, dimension: 3 }))
      .rejects.toThrow('readiness probe failed');

    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
  });

  it('stops waiting and reaps descendants when the launcher exits before readiness', async () => {
    let readinessSignal: AbortSignal | undefined;
    embeddingMocks.waitForEmbeddingReady.mockImplementation((_host, _port, _timeout, signal) =>
      new Promise<boolean>((_resolve, reject) => {
        readinessSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );

    const startPromise = startEmbeddingServer({ port, dimension: 3 });
    await vi.waitFor(() => expect(readinessSignal).toBeDefined());
    const child = childMocks.spawn.mock.results[0].value as EventEmitter;
    child.emit('exit', null, 'SIGTERM');

    await expect(startPromise).rejects.toThrow('Embedding launcher exited with signal SIGTERM');
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
  });

  it('reports failure if the process tree cannot be reaped after readiness fails', async () => {
    embeddingMocks.waitForEmbeddingReady.mockResolvedValue(false);
    processMocks.killProcessTree.mockRejectedValue(new Error('process tree 7000 did not exit'));

    await expect(startEmbeddingServer({ port, dimension: 3, readyTimeout: 1000 }))
      .rejects.toThrow('Failed to reap the embedding process: process tree 7000 did not exit');
  });

  it('persists the listener PID and passes it through status and stop', async () => {
    await startEmbeddingServer({ port, dimension: 3 });

    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    const writtenPidFile = JSON.parse(fsMocks.writeFile.mock.calls[0][1] as string) as {
      pid: number;
      port: number;
    };
    expect(writtenPidFile).toMatchObject({ pid, port });
    expect(writtenPidFile.pid).not.toBe(launcherPid);

    await showEmbeddingStatus({});
    expect(stateMocks.evaluateEmbeddingStatus).toHaveBeenCalledWith(expect.objectContaining({
      port,
      pidFile: expect.objectContaining({
        value: expect.objectContaining({ pid }),
      }),
    }));

    await stopEmbeddingServer({});
    expect(processMocks.killProcess).toHaveBeenCalledWith(pid, 5000, false);
    expect(embeddingMocks.verifyEmbeddingStopped).toHaveBeenCalledWith('127.0.0.1', port, pid, 5000);
    expect(embeddingMocks.removeEmbeddingPidFile).toHaveBeenCalledOnce();
  });
});
