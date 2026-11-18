import { DBEngine } from '@search-docs/db-engine';
import { FileStorage } from '@search-docs/storage';
import { WatcherProcess } from '../../../dist/watcher/watcher-process.js';
import { IndexWorker } from '../../../dist/worker/index-worker.js';
import { SearchDocsServer } from '../../../dist/server/search-docs-server.js';
import { promises as fs } from 'node:fs';

let db, storage, watcher, service;
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
        storage: { indexPath: args.dbPath },
        watcher: { enabled: false }, worker: { enabled: false },
      };
      watcher = new WatcherProcess(config, storage, db);
      service = new SearchDocsServer(config, storage, db);
      service.setWatcherProcess(watcher);
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
    } else if (command === 'warning') {
      watcher.reportWarning('injected deferred reconciliation');
    } else if (command === 'clean-warning') {
      watcher.reconciliationWarnings = [];
      watcher.sharedWarnings.publish([]);
      await watcher.sharedWarnings.pending;
    } else if (command === 'fail-warning-publication') {
      const writeFile = fs.writeFile;
      const rm = fs.rm;
      fs.writeFile = async (file, ...rest) => {
        if (String(file).includes('.search-docs-warnings-')) throw new Error('injected write failure');
        return writeFile(file, ...rest);
      };
      fs.rm = async (file, ...rest) => {
        if (String(file).includes('.search-docs-warnings-')) throw new Error('injected remove failure');
        return rm(file, ...rest);
      };
      try {
        watcher.reportWarning('injected deferred reconciliation');
        await watcher.sharedWarnings.pending;
      } finally {
        fs.writeFile = writeFile;
        fs.rm = rm;
      }
      value = await watcher.sharedWarnings.read(watcher.writerId);
    } else if (command === 'service-status') {
      value = await service.getStatus();
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
