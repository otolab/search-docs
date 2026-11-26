import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { WatcherProcess } from '../watcher/watcher-process.js';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsConfig } from '@search-docs/types';

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
    let requestId = 0;
    const invokeRemoteWriter = (command: string, args: unknown = {}) => new Promise<unknown>((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        remoteWriter.off('message', receive);
        reject(new Error(`Remote writer command timed out: ${command}`));
      }, 15000);
      const receive = (message: { id: number; value?: unknown; error?: string }) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        remoteWriter.off('message', receive);
        if (message.error) reject(new Error(message.error));
        else resolve(message.value);
      };
      remoteWriter.on('message', receive);
      remoteWriter.send({ id, command, args }, error => {
        if (!error) return;
        clearTimeout(timer);
        remoteWriter.off('message', receive);
        reject(error);
      });
    });
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
      await invokeRemoteWriter('connect', { dbPath: join(root, 'db') });
      const remoteEnvironment = await invokeRemoteWriter('write-heartbeat', { writerId: 'other' }) as {
        timeZone: string;
        updatedAt: string;
      };
      expect(remoteEnvironment.timeZone).toBe('America/Los_Angeles');
      expect(remoteEnvironment.updatedAt).toMatch(/\+00:00$/);

      // 過去timestampを直接投入せず、短縮したleaseの自然経過で期限切れを作る。
      constants.MASTER_TIMEOUT_MS = 1000;
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
      await internal.checkAndClaimMaster();
      expect(claim).not.toHaveBeenCalled();
      expect(watcher.getStatus().writerState).toBe('sleeping');
      internal.startMasterCheck();
      await vi.waitFor(() => expect(watcher!.getStatus().writerState).toBe('watching'), { timeout: 10000 });
      expect(claim).toHaveBeenCalledTimes(1);
      expect((await engine.getWriterHeartbeat()).heartbeat?.writerId).toBe(watcher.getStatus().writerId);
    } finally {
      try {
        if (watcher) await watcher.stop();
        else await db?.disconnect();
      } finally {
        if (remoteWriter.exitCode === null) {
          const exited = new Promise<void>(resolve => remoteWriter.once('exit', () => resolve()));
          await invokeRemoteWriter('stop').catch(() => {});
          await exited;
        }
        if (embeddingServerStarted) embeddingServer.close();
        for (const key of ['MASTER_TIMEOUT_MS', 'MASTER_CHECK_INTERVAL_MS', 'CLAIM_JITTER_MAX_MS', 'CLAIM_READBACK_DELAY_MS']) constants[key] = oldConstants[key];
        if (oldZone === undefined) delete process.env.TZ;
        else process.env.TZ = oldZone;
        rmSync(root, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    }
  }, 30000);
});
