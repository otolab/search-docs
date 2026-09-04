import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stopEmbeddingServer } from '../stop.js';

const processMocks = vi.hoisted(() => ({
  isProcessAlive: vi.fn(),
  getListeningProcess: vi.fn(),
  killProcess: vi.fn(),
}));
const embeddingMocks = vi.hoisted(() => ({
  readEmbeddingPidFile: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  processMocks.isProcessAlive.mockReturnValue(true);
  processMocks.getListeningProcess.mockReturnValue({ pid: 4321, command: 'external-server' });
  processMocks.killProcess.mockResolvedValue(undefined);
  embeddingMocks.readEmbeddingPidFile.mockResolvedValue({ exists: false, value: null });
  embeddingMocks.isPortAvailable.mockResolvedValue(true);
  embeddingMocks.verifyEmbeddingStopped.mockResolvedValue({
    processExited: true,
    portReleased: true,
    healthUnreachable: true,
  });
});

describe('stopEmbeddingServer', () => {
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
    embeddingMocks.readEmbeddingPidFile.mockResolvedValue({
      exists: true,
      value: { pid: 9876, port: 24281, startedAt: new Date().toISOString() },
    });
    processMocks.isProcessAlive.mockReturnValue(true);
    processMocks.getListeningProcess.mockReturnValue(null);

    await expect(stopEmbeddingServer()).rejects.toThrow(/Refusing to kill a possibly reused PID/);
    expect(processMocks.killProcess).not.toHaveBeenCalled();
  });
});
