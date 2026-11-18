import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatcherProcess } from '../watcher/watcher-process.js';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsConfig } from '@search-docs/types';

type WatcherProcessInternals = {
  writerId: string;
  writerState: 'sleeping' | 'claiming' | 'watching';
  watcher?: {
    isRunning: () => boolean;
    stop: () => Promise<void>;
  };
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
};

function createConfig(): SearchDocsConfig {
  return {
    version: '1.0',
    project: {
      name: 'watcher-process-test',
      root: process.cwd(),
    },
    files: {
      sources: ['**/*.md'],
      exclude: [],
      ignoreGitignore: false,
      maxFileSize: 10 * 1024 * 1024,
    },
    indexing: {
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    },
    search: {
      defaultLimit: 10,
      maxLimit: 100,
      includeCleanOnly: false,
    },
    server: {
      host: 'localhost',
      port: 24280,
      protocol: 'json-rpc',
    },
    storage: {
      documentsPath: process.cwd(),
      indexPath: process.cwd(),
      cachePath: process.cwd(),
    },
    worker: {
      enabled: false,
      interval: 1000,
      maxConcurrent: 1,
    },
    watcher: {
      enabled: false,
      debounceMs: 100,
      awaitWriteFinishMs: 100,
    },
  };
}

function heartbeatFor(writerId: string) {
  return {
    exists: true,
    heartbeat: {
      writerId,
      host: 'localhost',
      pid: 1234,
      state: 'watching',
      updatedAt: new Date().toISOString(),
      ageSeconds: 0,
    },
  };
}

function internals(process: WatcherProcess): WatcherProcessInternals {
  return process as unknown as WatcherProcessInternals;
}

describe('WatcherProcess heartbeat failure handling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps watching when mastership remains after a heartbeat failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dbEngineMock = {
      updateHeartbeat: vi.fn().mockRejectedValue(new Error('Retryable commit conflict: Please retry')),
      getWriterHeartbeat: vi.fn(),
    };
    const watcherProcess = new WatcherProcess(
      createConfig(),
      {} as FileStorage,
      dbEngineMock as unknown as DBEngine,
    );
    const processInternals = internals(watcherProcess);
    processInternals.writerState = 'watching';
    const watcher = {
      isRunning: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    processInternals.watcher = watcher;
    dbEngineMock.getWriterHeartbeat.mockResolvedValue(heartbeatFor(processInternals.writerId));

    processInternals.startHeartbeat();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(watcher.stop).not.toHaveBeenCalled();
    expect(watcherProcess.getStatus().writerState).toBe('watching');
    processInternals.stopHeartbeat();
  });

  it('transitions to sleeping when mastership is lost after retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const dbEngineMock = {
      updateHeartbeat: vi.fn().mockRejectedValue(new Error('Retryable commit conflict: Please retry')),
      getWriterHeartbeat: vi.fn(),
    };
    const watcherProcess = new WatcherProcess(
      createConfig(),
      {} as FileStorage,
      dbEngineMock as unknown as DBEngine,
    );
    const processInternals = internals(watcherProcess);
    processInternals.writerState = 'watching';
    const watcher = {
      isRunning: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    processInternals.watcher = watcher;
    dbEngineMock.getWriterHeartbeat.mockResolvedValue(heartbeatFor('other-writer'));

    processInternals.startHeartbeat();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(watcherProcess.getStatus().writerState).toBe('sleeping');
    processInternals.stopHeartbeat();
  });
});
