import { DBEngine } from '@search-docs/db-engine';
import { FileStorage } from '@search-docs/storage';
import { WatcherProcess } from '../../../dist/watcher/watcher-process.js';
import { IndexWorker } from '../../../dist/worker/index-worker.js';

let db, storage, watcher;
process.on('message', async ({ id, command, args }) => {
  try {
    let value;
    if (command === 'init') {
      db = new DBEngine({ dbPath: args.dbPath, embeddingUrl: args.embeddingUrl });
      await db.connect();
      storage = new FileStorage({ basePath: args.storagePath });
      const config = {
        project: { root: args.project },
        files: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 100000 },
        indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
        watcher: { enabled: false }, worker: { enabled: false },
      };
      watcher = new WatcherProcess(config, storage, db);
      watcher.startupSyncWorker = { startSync() {}, async waitForSync() {} };
    } else if (command === 'claim') {
      await db.claimWriter({ writerId: watcher.writerId, host: 'test', pid: process.pid });
      await watcher.transitionToWatching();
      value = watcher.getStatus().writerId;
    } else if (command === 'coordinate') {
      WatcherProcess.MASTER_TIMEOUT_MS = 8000;
      WatcherProcess.MASTER_CHECK_INTERVAL_MS = 250;
      WatcherProcess.CLAIM_JITTER_MAX_MS = 0;
      WatcherProcess.CLAIM_READBACK_DELAY_MS = 0;
      await watcher.checkAndClaimMaster();
      watcher.startMasterCheck();
      value = watcher.getStatus();
    } else if (command === 'status') {
      value = { status: watcher.getStatus(), heartbeat: await db.getWriterHeartbeat() };
    } else if (command === 'fail-release-stop') {
      db.releaseWriter = async () => { throw new Error('injected writer release failure'); };
      await watcher.stop();
    } else if (command === 'event') {
      await watcher.handleFileChange(args);
    } else if (command === 'processing') {
      const pending = await db.findIndexRequests({ status: 'pending' });
      if (pending.length !== 1) throw new Error(`expected one pending request, got ${pending.length}`);
      await db.updateIndexRequest(pending[0].id, { status: 'processing' });
      value = pending[0].id;
    } else if (command === 'run') {
      const worker = new IndexWorker({ dbEngine: db, storage, splitter: watcher.splitter });
      await worker.processNextRequests();
    } else if (command === 'inspect') {
      value = { sections: (await db.getSectionsByPath('a.md')).sections, document: await storage.get('a.md'), requests: await db.findIndexRequests() };
    } else if (command === 'stop') {
      await watcher.stop();
    } else if (command === 'exit') {
      db.disconnect();
      process.send?.({ id, value: null }, () => process.exit(0));
      return;
    }
    process.send?.({ id, value });
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
