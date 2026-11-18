import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
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
    const db = new DBEngine({ dbPath: join(root, 'db') });
    let watcher: WatcherProcess | undefined;
    try {
      process.env.TZ = 'Asia/Tokyo';
      await db.connect({ skipInitModel: true });
      // The writer is a separate process in a timezone behind UTC.
      const script = `
import sys
from datetime import datetime, timedelta, timezone
import lancedb
from schemas import get_writer_heartbeat_schema, get_index_requests_schema
path, age = sys.argv[1:]
db = lancedb.connect(path)
if 'writer_heartbeat' not in db.table_names():
    db.create_table('writer_heartbeat', schema=get_writer_heartbeat_schema())
if 'index_requests' not in db.table_names():
    db.create_table('index_requests', schema=get_index_requests_schema())
table = db.open_table('writer_heartbeat')
table.add([{'writer_id': 'other', 'host': 'test', 'pid': 1, 'state': 'watching',
            'updated_at': datetime.now(timezone.utc) - timedelta(seconds=int(age))}], mode='overwrite')
`;
      const pythonDir = resolve(process.cwd(), '../db-engine/src/python');
      const runWriter = (age: number) => {
        const env = { ...process.env, TZ: 'America/Los_Angeles', PYTHONPATH: pythonDir };
        const args = process.env.IS_DOCKER === 'true'
          ? ['-c', script, join(root, 'db'), String(age)]
          : ['--project', resolve(process.cwd(), '../db-engine'), 'run', 'python', '-c', script, join(root, 'db'), String(age)];
        execFileSync(process.env.IS_DOCKER === 'true' ? 'python' : 'uv', args, { env });
      };
      runWriter(0);
      constants.MASTER_CHECK_INTERVAL_MS = 500;
      constants.CLAIM_JITTER_MAX_MS = 0;
      constants.CLAIM_READBACK_DELAY_MS = 0;
      watcher = new WatcherProcess(createConfig(), {} as FileStorage, db);
      const internal = watcher as unknown as {
        checkAndClaimMaster: () => Promise<void>;
        startMasterCheck: () => void;
        startupSyncWorker: { startSync: () => void; waitForSync: () => Promise<void> };
      };
      internal.startupSyncWorker = { startSync: () => {}, waitForSync: async () => {} };
      const claim = vi.spyOn(db, 'claimWriter');
      await internal.checkAndClaimMaster();
      expect(claim).not.toHaveBeenCalled();
      expect(watcher.getStatus().writerState).toBe('sleeping');
      internal.startMasterCheck();
      runWriter(121);
      await vi.waitFor(() => expect(watcher!.getStatus().writerState).toBe('watching'), { timeout: 10000 });
      expect(claim).toHaveBeenCalledTimes(1);
      expect((await db.getWriterHeartbeat()).heartbeat?.writerId).toBe(watcher.getStatus().writerId);
    } finally {
      if (watcher) await watcher.stop();
      else db.disconnect();
      for (const key of ['MASTER_CHECK_INTERVAL_MS', 'CLAIM_JITTER_MAX_MS', 'CLAIM_READBACK_DELAY_MS']) constants[key] = oldConstants[key];
      if (oldZone === undefined) delete process.env.TZ;
      else process.env.TZ = oldZone;
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 30000);
});
