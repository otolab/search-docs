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
  handleFileChange: (event: { type: 'unlink'; path: string; timestamp: Date }) => Promise<void>;
  transitionToWatching: () => Promise<void>;
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

describe('WatcherProcess recovery and shutdown', () => {
  it('waits for an in-flight deletion before releasing writer ownership', async () => {
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const db = {
      deleteSectionsByPath: vi.fn(async () => { entered(); await gate; }),
      releaseWriter: vi.fn(async () => ({})),
      disconnect: vi.fn(),
    };
    const storage = { delete: vi.fn(async () => {}) };
    const instance = new WatcherProcess(createConfig(), storage as unknown as FileStorage, db as unknown as DBEngine);
    const internal = internals(instance);
    internal.writerState = 'watching';
    const deletion = internal.handleFileChange({ type: 'unlink', path: 'a.md', timestamp: new Date() });
    await started;
    const stopping = instance.stop();
    await Promise.resolve();
    expect(db.releaseWriter).not.toHaveBeenCalled();
    unblock();
    await Promise.all([deletion, stopping]);
    expect(storage.delete).toHaveBeenCalledWith('a.md');
    expect(db.releaseWriter).toHaveBeenCalledOnce();
  });

  it('returns interrupted processing requests to pending before starting workers', async () => {
    const db = {
      updateHeartbeat: vi.fn(async () => {}),
      updateManyIndexRequests: vi.fn(async () => ({ updated: true, count: 1 })),
    };
    const instance = new WatcherProcess(createConfig(), {} as FileStorage, db as unknown as DBEngine);
    const internal = internals(instance);
    internal.startHeartbeat = vi.fn();
    await internal.transitionToWatching();
    expect(db.updateManyIndexRequests).toHaveBeenCalledWith({ status: 'processing' }, { status: 'pending' });
  });
});
