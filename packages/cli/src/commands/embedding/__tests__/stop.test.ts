import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stopEmbeddingServer } from '../stop.js';

const processMocks = vi.hoisted(() => ({
  isProcessAlive: vi.fn(),
  getListeningProcess: vi.fn(),
  killProcess: vi.fn(),
}));
const embeddingMocks = vi.hoisted(() => ({
  readEmbeddingPidFileForPort: vi.fn(),
  readUniqueEmbeddingPidFile: vi.fn(),
  isPortAvailable: vi.fn(),
  removeEmbeddingPidFile: vi.fn(),
  verifyEmbeddingStopped: vi.fn(),
}));

vi.mock('../../../utils/process.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/process.js')>('../../../utils/process.js');
  return { ...actual, ...processMocks };
});
vi.mock('../../../utils/embedding.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/embedding.js')>('../../../utils/embedding.js');
  return { ...actual, ...embeddingMocks };
});

const launchId = 'launch-token-123';
const managedPidFile = {
  pid: 4321,
  port: 24281,
  startedAt: new Date().toISOString(),
  launchId,
};

beforeEach(() => {
  vi.clearAllMocks();
  processMocks.isProcessAlive.mockReturnValue(true);
  processMocks.getListeningProcess.mockReturnValue({ pid: 4321, command: 'external-server' });
  processMocks.killProcess.mockResolvedValue(undefined);
  embeddingMocks.readEmbeddingPidFileForPort.mockResolvedValue({ exists: false, value: null });
  embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
    state: { exists: false, value: null },
    ambiguousPorts: [],
  });
  embeddingMocks.isPortAvailable.mockResolvedValue(true);
  embeddingMocks.verifyEmbeddingStopped.mockResolvedValue({
    processExited: true,
    portReleased: true,
    healthUnreachable: true,
  });
});

describe('stopEmbeddingServer', () => {
  it('requires an explicit port to stop an external server when no PID file exists', async () => {
    await expect(stopEmbeddingServer()).rejects.toThrow(
      /No embedding server PID file found\. Specify --port <port> to stop an externally managed server/,
    );

    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });

  it('stops an external server by port without a PID file', async () => {
    await stopEmbeddingServer({ port: 24281 });

    expect(processMocks.killProcess).toHaveBeenCalledWith(4321, 5000, false);
    expect(embeddingMocks.verifyEmbeddingStopped).toHaveBeenCalledWith('127.0.0.1', 24281, 4321, 5000);
  });

  it('uses SIGKILL explicitly when --force is requested', async () => {
    await stopEmbeddingServer({ port: 24281, force: true });

    expect(processMocks.killProcess).toHaveBeenCalledWith(4321, 1000, true);
    expect(embeddingMocks.verifyEmbeddingStopped).toHaveBeenCalledWith('127.0.0.1', 24281, 4321, 3000);
  });

  it('refuses to kill a live PID file process when the port owner is unknown', async () => {
    embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
      state: {
      exists: true,
      value: { ...managedPidFile, pid: 9876 },
      },
      port: 24281,
      ambiguousPorts: [],
    });
    processMocks.isProcessAlive.mockReturnValue(true);
    processMocks.getListeningProcess.mockReturnValue(null);

    await expect(stopEmbeddingServer({ force: true })).rejects.toThrow(/Refusing to kill a possibly reused PID/);
    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });

  it('refuses a legacy PID record during ordinary stop even when its PID owns the port', async () => {
    embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
      state: {
        exists: true,
        path: '/tmp/embedding.pid',
        legacy: true,
        value: { pid: 4321, port: 24281, startedAt: new Date().toISOString() },
      },
      port: 24281,
      ambiguousPorts: [],
    });
    processMocks.getListeningProcess.mockReturnValue({ pid: 4321, command: 'python embedding_server.py' });

    await expect(stopEmbeddingServer()).rejects.toThrow(/legacy records cannot prove ownership/);

    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });

  it('preserves explicit --port as an intentional external stop for a legacy record', async () => {
    embeddingMocks.readEmbeddingPidFileForPort.mockResolvedValue({
      exists: true,
      path: '/tmp/embedding.pid',
      legacy: true,
      value: { pid: 4321, port: 24281, startedAt: new Date().toISOString() },
    });
    processMocks.getListeningProcess.mockReturnValue({ pid: 4321, command: 'python embedding_server.py' });

    await stopEmbeddingServer({ port: 24281 });

    expect(processMocks.killProcess).toHaveBeenCalledWith(4321, 5000, false);
    expect(embeddingMocks.removeEmbeddingPidFile).toHaveBeenCalledWith('/tmp/embedding.pid');
  });

  it('refuses a PID reused by a different process identity', async () => {
    embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
      state: { exists: true, value: managedPidFile },
      port: 24281,
      ambiguousPorts: [],
    });
    processMocks.getListeningProcess.mockReturnValue({
      pid: 4321,
      command: 'unrelated-process --pid-was-reused',
    });

    await expect(stopEmbeddingServer()).rejects.toThrow(/process identity.*does not match/);

    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });

  it('requires an explicit port when multiple managed servers are recorded', async () => {
    embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
      state: { exists: false, value: null },
      ambiguousPorts: [24281, 24282],
    });

    await expect(stopEmbeddingServer()).rejects.toThrow(/Specify --port <port>/);

    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });

  it('removes only the selected stale per-port record when its process and listener are gone', async () => {
    embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
      state: {
        exists: true,
        path: '/tmp/embedding-24281.pid',
        value: managedPidFile,
      },
      port: 24281,
      ambiguousPorts: [],
    });
    processMocks.isProcessAlive.mockReturnValue(false);
    processMocks.getListeningProcess.mockReturnValue(null);

    await stopEmbeddingServer();

    expect(embeddingMocks.removeEmbeddingPidFile).toHaveBeenCalledWith('/tmp/embedding-24281.pid');
    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });

  it('rechecks the listener before signaling a managed process', async () => {
    embeddingMocks.readUniqueEmbeddingPidFile.mockResolvedValue({
      state: { exists: true, value: managedPidFile },
      port: 24281,
      ambiguousPorts: [],
    });
    processMocks.getListeningProcess
      .mockReturnValueOnce({
        pid: 4321,
        command: `python embedding_server.py --search-docs-startup-id=${launchId}`,
      })
      .mockReturnValueOnce({ pid: 9999, command: 'replacement-server' });

    await expect(stopEmbeddingServer()).rejects.toThrow(/no longer owned by PID 4321/);

    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });
});
