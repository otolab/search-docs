import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { WatcherProcess } from '../watcher/watcher-process.js';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsConfig } from '@search-docs/types';

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function childExit(child: ChildProcess): ChildExit {
  return { code: child.exitCode, signal: child.signalCode };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  if (hasExited(child)) return Promise.resolve(childExit(child));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (hasExited(child)) onExit(child.exitCode, child.signalCode);
  });
}

function invokeChild(
  child: ChildProcess,
  id: number,
  command: string,
  args: unknown = {},
): Promise<unknown> {
  if (hasExited(child)) {
    return Promise.reject(new Error(`Remote writer already exited: ${JSON.stringify(childExit(child))}`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('id' in message) || message.id !== id) return;
      const response = message as { value?: unknown; error?: string };
      if (response.error) finish(new Error(response.error));
      else finish(undefined, response.value);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Remote writer exited before replying: ${JSON.stringify({ code, signal })}`));
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(`Remote writer command timed out: ${command} (${REQUEST_TIMEOUT_MS}ms)`));
    }, REQUEST_TIMEOUT_MS);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
    if (hasExited(child)) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    try {
      child.send({ id, command, args }, error => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const REQUEST_TIMEOUT_MS = 20_000;
const CHILD_EXIT_TIMEOUT_MS = 5_000;

async function stopRemoteWriter(child: ChildProcess, id: number, childErrors: Error[]): Promise<void> {
  if (hasExited(child)) {
    throw new Error(`Remote writer exited before stop was requested: ${JSON.stringify(childExit(child))}`);
  }

  let stopError: Error | undefined;
  try {
    await invokeChild(child, id, 'stop');
  } catch (error) {
    stopError = error instanceof Error ? error : new Error(String(error));
  }

  let exit: ChildExit | undefined;
  const cleanupErrors: Error[] = [];
  if (stopError && !hasExited(child)) {
    try {
      if (!child.kill('SIGTERM') && !hasExited(child)) {
        cleanupErrors.push(new Error('Could not send SIGTERM to remote writer'));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  try {
    exit = await waitForChildExit(child, CHILD_EXIT_TIMEOUT_MS);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    try {
      if (!child.kill('SIGKILL') && !hasExited(child)) {
        cleanupErrors.push(new Error('Could not send SIGKILL to remote writer'));
      }
    } catch (killError) {
      cleanupErrors.push(killError instanceof Error ? killError : new Error(String(killError)));
    }
    try {
      exit = await waitForChildExit(child, CHILD_EXIT_TIMEOUT_MS);
    } catch (waitError) {
      cleanupErrors.push(waitError instanceof Error ? waitError : new Error(String(waitError)));
    }
  }

  if (stopError) cleanupErrors.unshift(stopError);
  cleanupErrors.push(...childErrors);
  if (!exit) cleanupErrors.push(new Error('Remote writer exit status was not observed'));
  else if (exit.code !== 0 || exit.signal !== null) {
    cleanupErrors.push(new Error(`Remote writer stopped unexpectedly: ${JSON.stringify(exit)}`));
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Remote writer did not stop cleanly');
  }
}

function workerGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function signalWorkerGroup(pid: number, signal: NodeJS.Signals): void {
  if (!workerGroupExists(pid)) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForWorkerGroupsToExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(workerGroupExists)) {
    if (Date.now() >= deadline) {
      throw new Error(`DBEngine worker groups did not exit within ${timeoutMs}ms: ${pids.join(', ')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function forceStopWorkerGroups(pids: number[]): Promise<void> {
  const errors: Error[] = [];
  for (const pid of pids) {
    try {
      signalWorkerGroup(pid, 'SIGTERM');
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  try {
    await waitForWorkerGroupsToExit(pids, CHILD_EXIT_TIMEOUT_MS);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
    for (const pid of pids) {
      try {
        signalWorkerGroup(pid, 'SIGKILL');
      } catch (killError) {
        errors.push(killError instanceof Error ? killError : new Error(String(killError)));
      }
    }
    try {
      await waitForWorkerGroupsToExit(pids, CHILD_EXIT_TIMEOUT_MS);
    } catch (waitError) {
      errors.push(waitError instanceof Error ? waitError : new Error(String(waitError)));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Could not clean up DBEngine worker groups');
}

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


describe('writer coordination with LanceDB', () => {
  it('keeps a fresh writer and automatically takes over after expiry across timezones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heartbeat-tz-'));
    const oldZone = process.env.TZ;
    const constants = WatcherProcess as unknown as Record<string, number>;
    const oldConstants = { ...constants };
    let db: DBEngine | undefined;
    const embeddingServer = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: 'test', vectorDimension: 256 }));
    });
    // 短命な `python -c` を都度終了させず、別TZのDBEngine workerをchild processとして使う。
    const remoteWriter = fork(join(process.cwd(), 'src/__tests__/fixtures/writer-heartbeat-child.mjs'), [], {
      env: { ...process.env, TZ: 'America/Los_Angeles' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const remoteWriterErrors: Error[] = [];
    remoteWriter.on('error', error => remoteWriterErrors.push(error));
    let requestId = 0;
    let remoteWorkerPids: number[] = [];
    const invokeRemoteWriter = (command: string, args: unknown = {}) =>
      invokeChild(remoteWriter, ++requestId, command, args);
    let watcher: WatcherProcess | undefined;
    let embeddingServerStarted = false;
    try {
      process.env.TZ = 'Asia/Tokyo';
      embeddingServer.listen(0, '127.0.0.1');
      await once(embeddingServer, 'listening');
      embeddingServerStarted = true;
      const port = (embeddingServer.address() as { port: number }).port;
      const engine = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
      db = engine;
      await engine.connect();
      const remoteConnection = await invokeRemoteWriter('connect', { dbPath: join(root, 'db') }) as {
        workerPids: number[];
      };
      remoteWorkerPids = remoteConnection.workerPids;
      const remoteEnvironment = await invokeRemoteWriter('write-heartbeat', { writerId: 'other' }) as {
        timeZone: string;
        updatedAt: string;
      };
      expect(remoteEnvironment.timeZone).toBe('America/Los_Angeles');
      expect(remoteEnvironment.updatedAt).toMatch(/\+00:00$/);

      // 過去timestampを直接投入せず、短縮したleaseの自然経過で期限切れを作る。
      constants.MASTER_TIMEOUT_MS = 10_000;
      constants.MASTER_CHECK_INTERVAL_MS = 100;
      constants.CLAIM_JITTER_MAX_MS = 0;
      constants.CLAIM_READBACK_DELAY_MS = 0;
      const config = createConfig();
      config.storage.indexPath = join(root, 'db');
      watcher = new WatcherProcess(config, {} as FileStorage, engine);
      const internal = watcher as unknown as {
        checkAndClaimMaster: () => Promise<void>;
        startMasterCheck: () => void;
        startupSyncWorker: { startSync: () => void; waitForSync: () => Promise<void> };
      };
      internal.startupSyncWorker = { startSync: () => {}, waitForSync: async () => {} };
      const claim = vi.spyOn(engine, 'claimWriter');
      const freshHeartbeat = (await engine.getWriterHeartbeat()).heartbeat;
      expect(freshHeartbeat?.writerId).toBe('other');
      expect(freshHeartbeat!.ageSeconds).toBeLessThan(1);
      let ageAtClaimCheck: number | undefined;
      const getHeartbeat = engine.getWriterHeartbeat.bind(engine);
      vi.spyOn(engine, 'getWriterHeartbeat').mockImplementation(async () => {
        const result = await getHeartbeat();
        if (result.heartbeat?.writerId === 'other') ageAtClaimCheck = result.heartbeat.ageSeconds;
        return result;
      });
      await internal.checkAndClaimMaster();
      expect(ageAtClaimCheck).toBeDefined();
      expect(ageAtClaimCheck).toBeLessThan(constants.MASTER_TIMEOUT_MS / 1000 - 5);
      expect(claim).not.toHaveBeenCalled();
      expect(watcher.getStatus().writerState).toBe('sleeping');
      internal.startMasterCheck();
      await vi.waitFor(
        () => expect(watcher!.getStatus().writerState).toBe('watching'),
        { timeout: constants.MASTER_TIMEOUT_MS + 10_000 },
      );
      expect(claim).toHaveBeenCalledTimes(1);
      expect((await engine.getWriterHeartbeat()).heartbeat?.writerId).toBe(watcher.getStatus().writerId);
    } finally {
      try {
        if (watcher) await watcher.stop();
        else await db?.disconnect();
      } finally {
        try {
          await stopRemoteWriter(remoteWriter, ++requestId, remoteWriterErrors);
        } catch (error) {
          const cleanupErrors = [error instanceof Error ? error : new Error(String(error))];
          try {
            await forceStopWorkerGroups(remoteWorkerPids);
          } catch (killError) {
            cleanupErrors.push(killError instanceof Error ? killError : new Error(String(killError)));
          }
          throw new AggregateError(cleanupErrors, 'Remote writer cleanup failed');
        } finally {
          if (embeddingServerStarted) embeddingServer.close();
          for (const key of ['MASTER_TIMEOUT_MS', 'MASTER_CHECK_INTERVAL_MS', 'CLAIM_JITTER_MAX_MS', 'CLAIM_READBACK_DELAY_MS']) constants[key] = oldConstants[key];
          if (oldZone === undefined) delete process.env.TZ;
          else process.env.TZ = oldZone;
          rmSync(root, { recursive: true, force: true });
          vi.restoreAllMocks();
        }
      }
    }
  }, 60000);
});
