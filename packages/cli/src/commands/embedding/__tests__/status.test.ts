import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  showEmbeddingStatus,
} from '../status.js';
import type { EmbeddingPidFileState } from '../../../utils/embedding.js';
import type { EmbeddingStatusSnapshot } from '../../../utils/embedding-state.js';

const embeddingMocks = vi.hoisted(() => ({
  readEmbeddingPidFile: vi.fn(),
  removeEmbeddingPidFile: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
  evaluateEmbeddingStatus: vi.fn(),
}));

vi.mock('../../../utils/embedding.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/embedding.js')>('../../../utils/embedding.js');
  return { ...actual, ...embeddingMocks };
});
vi.mock('../../../utils/embedding-state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/embedding-state.js')>('../../../utils/embedding-state.js');
  return { ...actual, ...stateMocks };
});

function snapshot(overallState: EmbeddingStatusSnapshot['overallState']): EmbeddingStatusSnapshot {
  return {
    overallState,
    host: '127.0.0.1',
    port: 31337,
    pidFile: { exists: true, value: { pid: 1234, port: 31337, startedAt: new Date().toISOString() } },
    pidAlive: overallState !== 'stale_pid',
    portListening: overallState !== 'not_running',
    portOwner: null,
    health: null,
    readiness: null,
    embedProbe: null,
    checks: [],
    suggestions: [],
    startupGraceMs: 120000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  embeddingMocks.readEmbeddingPidFile.mockResolvedValue({
    exists: true,
    value: { pid: 1234, port: 31337, startedAt: new Date().toISOString() },
  } satisfies EmbeddingPidFileState);
  stateMocks.evaluateEmbeddingStatus.mockResolvedValue(snapshot('healthy'));
});

describe('showEmbeddingStatus', () => {
  it('uses the PID file port when --port is omitted', async () => {
    await showEmbeddingStatus({ verbose: true });

    expect(stateMocks.evaluateEmbeddingStatus).toHaveBeenCalledWith(expect.objectContaining({ port: 31337 }));
  });

  it('repairs a stale PID file and evaluates the repaired state', async () => {
    stateMocks.evaluateEmbeddingStatus
      .mockResolvedValueOnce(snapshot('stale_pid'))
      .mockResolvedValueOnce({ ...snapshot('not_running'), pidFile: { exists: false, value: null } });

    const result = await showEmbeddingStatus({ repair: true });

    expect(embeddingMocks.removeEmbeddingPidFile).toHaveBeenCalledOnce();
    expect(result.repaired).toBe(true);
    expect(result.snapshot.overallState).toBe('not_running');
  });
});

