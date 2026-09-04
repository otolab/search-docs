import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateEmbeddingStatus,
} from '../embedding-state.js';
import type {
  EmbeddingHealthResponse,
  EmbeddingPidFileState,
  EmbeddingProbeResult,
  EmbeddingReadinessResponse,
} from '../embedding.js';

const processMocks = vi.hoisted(() => ({
  isProcessAlive: vi.fn(),
  isPortAvailable: vi.fn(),
  getListeningProcess: vi.fn(),
}));

const embeddingMocks = vi.hoisted(() => ({
  checkEmbeddingHealth: vi.fn(),
  checkEmbeddingReadiness: vi.fn(),
  probeEmbedding: vi.fn(),
  findEmbeddingHealth: vi.fn(),
  findEmbeddingReadiness: vi.fn(),
  findEmbeddingProbe: vi.fn(),
}));

vi.mock('../process.js', () => processMocks);
vi.mock('../embedding.js', async () => {
  const actual = await vi.importActual<typeof import('../embedding.js')>('../embedding.js');
  return { ...actual, ...embeddingMocks };
});

const pidFile = (overrides: Partial<EmbeddingPidFileState> = {}): EmbeddingPidFileState => ({
  exists: true,
  value: {
    pid: 1234,
    port: 24281,
    startedAt: new Date(Date.now() - 300_000).toISOString(),
    model: 'ruri',
    dimension: 3,
  },
  ...overrides,
});

const health = (overrides: Partial<EmbeddingHealthResponse> = {}): EmbeddingHealthResponse => ({
  status: 'ok',
  model: 'ruri',
  vectorDimension: 3,
  ready: true,
  ...overrides,
});

const readiness = (ready = true): EmbeddingReadinessResponse => ({
  ready,
  statusCode: ready ? 200 : 503,
  latencyMs: 2,
});

const probe = (success = true): EmbeddingProbeResult => ({
  success,
  latencyMs: 4,
  endpoint: '/api/embed',
  vectorDimension: 3,
});

function snapshotOptions(overrides: Partial<Parameters<typeof evaluateEmbeddingStatus>[0]> = {}) {
  return {
    port: 24281,
    pidFile: pidFile(),
    now: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  processMocks.isProcessAlive.mockReturnValue(true);
  processMocks.isPortAvailable.mockResolvedValue(false);
  processMocks.getListeningProcess.mockReturnValue({ pid: 1234, command: 'embedding_server.py' });
  embeddingMocks.checkEmbeddingHealth.mockResolvedValue(health());
  embeddingMocks.checkEmbeddingReadiness.mockResolvedValue(readiness());
  embeddingMocks.probeEmbedding.mockResolvedValue(probe());
  embeddingMocks.findEmbeddingHealth.mockResolvedValue({ host: '127.0.0.1', health: health() });
  embeddingMocks.findEmbeddingReadiness.mockResolvedValue({ host: '127.0.0.1', readiness: readiness() });
  embeddingMocks.findEmbeddingProbe.mockResolvedValue({ host: '127.0.0.1', probe: probe() });
});

describe('evaluateEmbeddingStatus', () => {
  it('detects a stale PID file', async () => {
    processMocks.isProcessAlive.mockReturnValue(false);
    processMocks.isPortAvailable.mockResolvedValue(true);
    processMocks.getListeningProcess.mockReturnValue(null);
    embeddingMocks.checkEmbeddingHealth.mockResolvedValue(null);
    embeddingMocks.checkEmbeddingReadiness.mockResolvedValue(null);
    embeddingMocks.findEmbeddingHealth.mockResolvedValue(null);
    embeddingMocks.findEmbeddingReadiness.mockResolvedValue(null);

    const snapshot = await evaluateEmbeddingStatus(snapshotOptions());

    expect(snapshot.overallState).toBe('stale_pid');
    expect(snapshot.checks.find((check) => check.check === 'pid_alive')?.status).toBe('failed');
  });

  it('distinguishes an external healthy server without a PID file', async () => {
    const snapshot = await evaluateEmbeddingStatus(snapshotOptions({
      pidFile: { exists: false, value: null },
    }));

    expect(snapshot.overallState).toBe('orphan_process');
    expect(snapshot.checks.find((check) => check.check === 'pid_file')?.status).toBe('skipped');
  });

  it('reports a live HTTP server with a failed inference path as degraded', async () => {
    embeddingMocks.checkEmbeddingHealth.mockResolvedValue(health({ ready: false, status: 'degraded' }));
    embeddingMocks.checkEmbeddingReadiness.mockResolvedValue(readiness(false));
    embeddingMocks.probeEmbedding.mockResolvedValue({ ...probe(false), error: 'HTTP 500' });

    const snapshot = await evaluateEmbeddingStatus(snapshotOptions({ probe: true }));

    expect(snapshot.overallState).toBe('degraded');
    expect(snapshot.checks.find((check) => check.check === 'readiness')?.status).toBe('failed');
    expect(snapshot.checks.find((check) => check.check === 'embed_probe')?.status).toBe('failed');
  });

  it('does not promote liveness to healthy when /ready is unreachable', async () => {
    embeddingMocks.checkEmbeddingReadiness.mockResolvedValue(null);

    const snapshot = await evaluateEmbeddingStatus(snapshotOptions());

    expect(snapshot.overallState).toBe('degraded');
    expect(snapshot.checks.find((check) => check.check === 'readiness')?.status).toBe('failed');
  });

  it('reports an IPv6 health endpoint as the active host', async () => {
    embeddingMocks.findEmbeddingHealth.mockResolvedValue({ host: '::1', health: health() });
    embeddingMocks.checkEmbeddingReadiness.mockResolvedValue(readiness());

    const snapshot = await evaluateEmbeddingStatus(snapshotOptions());

    expect(snapshot.host).toBe('::1');
    expect(snapshot.overallState).toBe('healthy');
  });

  it('reports all checks healthy when PID, owner, readiness and probe agree', async () => {
    const snapshot = await evaluateEmbeddingStatus(snapshotOptions({ probe: true }));

    expect(snapshot.overallState).toBe('healthy');
    expect(snapshot.checks.every((check) => check.status === 'ok' || check.check === 'metadata_match')).toBe(true);
  });
});
