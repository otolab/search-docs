import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '@search-docs/types';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  heartbeat: vi.fn(),
  indexed: vi.fn(),
  pending: vi.fn(),
}));

vi.mock('@search-docs/db-engine', () => ({
  DBEngine: vi.fn(function () {
    return {
      connect: mocks.connect,
      disconnect: mocks.disconnect,
      getWriterHeartbeat: mocks.heartbeat,
      getIndexedPaths: mocks.indexed,
      getPathsWithStatus: mocks.pending,
    };
  }),
  UnconfirmedProcessStopError: class extends Error {},
}));

import { diagnoseStrictConfig } from '../strict-diagnostic.js';

describe('strict heartbeat diagnosis', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it('rejects an unreadable heartbeat except when explicitly selected for force repair', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'strict-heartbeat-'));
    await mkdir(path.join(root, '.search-docs/index'), { recursive: true });
    await mkdir(path.join(root, '.search-docs/documents'));
    const config = {
      ...DEFAULT_CONFIG,
      project: { ...DEFAULT_CONFIG.project, root },
      files: { ...DEFAULT_CONFIG.files, sources: [] },
    };
    mocks.connect.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.indexed.mockResolvedValue([]);
    mocks.pending.mockResolvedValue([]);
    mocks.heartbeat.mockRejectedValue(new Error('heartbeat unreadable'));

    await expect(diagnoseStrictConfig(config)).rejects.toThrow('heartbeat unreadable');
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    await expect(diagnoseStrictConfig(config, { skipTable: 'writer_heartbeat' })).resolves.toBeUndefined();
    expect(mocks.heartbeat).toHaveBeenCalledOnce();
  });
});
