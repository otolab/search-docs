import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  link: vi.fn(),
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
    link: fsMocks.link,
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
  fsMocks.link.mockResolvedValue(undefined);
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
  it('installs the torch extra only when the torch runtime is selected', async () => {
    await startEmbeddingServer({ port, runtime: 'torch' });
    expect(childMocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--extra', 'torch', '--runtime=torch']));
  });

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

    expect(childMocks.spawn.mock.calls[0][1]).not.toContain('--extra');
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

  it.each(['SIGINT', 'SIGTERM'] as const)('reaps the launcher when %s interrupts readiness', async (signal) => {
    let readinessSignal: AbortSignal | undefined;
    const before = process.listeners(signal);
    embeddingMocks.waitForEmbeddingReady.mockImplementation((_host, _port, _timeout, abortSignal) =>
      new Promise<boolean>((_resolve, reject) => {
        readinessSignal = abortSignal;
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      }),
    );
    const starting = startEmbeddingServer({ port });
    await vi.waitFor(() => expect(readinessSignal).toBeDefined());
    const handler = process.listeners(signal).find((listener) => !before.includes(listener));
    expect(handler).toBeDefined();
    handler!(signal);
    await starting;
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(process.listeners(signal)).toEqual(before);
  });

  it('does not publish a PID if interrupted after readiness during health lookup', async () => {
    let finishHealth!: (value: unknown) => void;
    embeddingMocks.findEmbeddingHealth.mockReset().mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise((resolve) => { finishHealth = resolve; }));
    const before = process.listeners('SIGINT');
    const starting = startEmbeddingServer({ port });
    await vi.waitFor(() => expect(finishHealth).toBeDefined());
    process.listeners('SIGINT').find((listener) => !before.includes(listener))!('SIGINT');
    finishHealth({ health: health() });
    await starting;
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });

  it('cleans up the PID file if interrupted while it is being written', async () => {
    let finishWrite!: () => void;
    fsMocks.writeFile.mockImplementation(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const before = process.listeners('SIGTERM');
    const starting = startEmbeddingServer({ port });
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    process.listeners('SIGTERM').find((listener) => !before.includes(listener))!('SIGTERM');
    finishWrite();
    await starting;
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
    expect(fsMocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/embedding\.pid\..*\.tmp$/));
    expect(process.exitCode).toBe(143);
  });

  it('removes a partial temporary PID file without publishing it', async () => {
    fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(startEmbeddingServer({ port })).rejects.toThrow('disk full');
    expect(fsMocks.link).not.toHaveBeenCalled();
    expect(fsMocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/embedding\.pid\..*\.tmp$/));
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
  });

  it('removes a real partially written temporary PID file and can retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'embedding-pid-'));
    const pidPath = join(directory, 'embedding.pid');
    embeddingMocks.embeddingPidPath.mockReturnValue(pidPath);
    const actualFs = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    fsMocks.unlink.mockImplementation(actualFs.unlink);
    fsMocks.link.mockImplementation(actualFs.link);
    fsMocks.writeFile.mockImplementationOnce(async (filename: string) => {
      await actualFs.writeFile(filename, '{partial');
      throw new Error('disk full');
    }).mockImplementation(actualFs.writeFile);
    try {
      await expect(startEmbeddingServer({ port })).rejects.toThrow('disk full');
      expect(await readdir(directory)).toEqual([]);
      embeddingMocks.findEmbeddingHealth.mockReset().mockResolvedValueOnce(null)
        .mockResolvedValue({ host: '127.0.0.1', health: health() });
      await startEmbeddingServer({ port });
      expect(await readdir(directory)).toEqual(['embedding.pid']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not overwrite a concurrently created PID file', async () => {
    fsMocks.link.mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
    await expect(startEmbeddingServer({ port })).rejects.toThrow('already exists');
    expect(fsMocks.unlink).not.toHaveBeenCalledWith('/tmp/search-docs-embedding/embedding.pid');
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
  });

  it('does not hide cleanup failure after interruption', async () => {
    let abort: AbortSignal | undefined;
    embeddingMocks.waitForEmbeddingReady.mockImplementation((_host, _port, _timeout, signal) =>
      new Promise<boolean>((_resolve, reject) => {
        abort = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    processMocks.killProcessTree.mockRejectedValue(new Error('cannot reap'));
    const before = process.listeners('SIGTERM');
    const starting = startEmbeddingServer({ port });
    await vi.waitFor(() => expect(abort).toBeDefined());
    const handler = process.listeners('SIGTERM').find((listener) => !before.includes(listener))!;
    handler('SIGTERM');
    handler('SIGTERM');
    await expect(starting).rejects.toThrow('Failed to reap the embedding process: cannot reap');
    expect(processMocks.killProcessTree).toHaveBeenCalledOnce();
    expect(process.listeners('SIGTERM')).toEqual(before);
  });

  it('does not manage or kill an already running external server', async () => {
    embeddingMocks.findEmbeddingHealth.mockReset().mockResolvedValue({ host: '127.0.0.1', health: health() });
    await startEmbeddingServer({ port });
    expect(childMocks.spawn).not.toHaveBeenCalled();
    expect(processMocks.killProcessTree).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it('does not claim success when the launcher exits during PID file writing', async () => {
    let finishWrite!: () => void;
    fsMocks.writeFile.mockImplementation(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const starting = startEmbeddingServer({ port });
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    const child = childMocks.spawn.mock.results[0].value;
    child.exitCode = 1;
    child.emit('exit', 1, null);
    finishWrite();
    await expect(starting).rejects.toThrow('Embedding launcher exited with code 1');
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(launcherPid);
    expect(fsMocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/embedding\.pid\..*\.tmp$/));
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
