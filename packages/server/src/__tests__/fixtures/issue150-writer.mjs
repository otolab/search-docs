import { DBEngine } from '@search-docs/db-engine';
import { FileStorage } from '@search-docs/storage';
import { WatcherProcess } from '../../../dist/watcher/watcher-process.js';
import { IndexWorker } from '../../../dist/worker/index-worker.js';
import { SearchDocsServer } from '../../../dist/server/search-docs-server.js';
import { registerIndexStatusTool } from '../../../../mcp-server/dist/tools/index-status.js';

let db, storage, watcher, service, originalHeartbeat;
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
    } else if (command === 'short-heartbeat') {
      WatcherProcess.HEARTBEAT_INTERVAL_MS = 500;
    } else if (command === 'diagnose') {
      value = await db.diagnoseDuplicateSections();
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
      watcher.clearWarningTimer();
      watcher.reconciliationWarnings = [];
      watcher.omittedWarnings = 0;
      watcher.publishHeartbeat();
      await watcher.heartbeatTail;
    } else if (command === 'many-warnings') {
      const previous = db.updateHeartbeat.bind(db);
      let updates = 0;
      let bytes = 0;
      const started = performance.now();
      db.updateHeartbeat = async params => {
        updates++;
        bytes += Buffer.byteLength(JSON.stringify(params));
        return previous(params);
      };
      try {
        for (let i = 0; i < args.count; i++) watcher.reportWarning(`起動時照合を保留しました: docs/${i}.md（監視範囲を確認できません）`);
        await new Promise(resolve => setTimeout(resolve, 300));
        await watcher.heartbeatTail;
        value = { updates, bytes, elapsedMs: performance.now() - started };
      } finally {
        db.updateHeartbeat = previous;
      }
    } else if (command === 'legacy-heartbeat') {
      await db.updateHeartbeat({ writerId: watcher.writerId, host: 'test', pid: process.pid, state: 'watching' });
    } else if (command === 'fail-warning-publication') {
      originalHeartbeat = db.updateHeartbeat.bind(db);
      db.updateHeartbeat = async () => { throw new Error('injected heartbeat write failure'); };
      watcher.reportWarning('injected deferred reconciliation');
      await new Promise(resolve => setTimeout(resolve, 300));
      await watcher.heartbeatTail;
    } else if (command === 'restore-publication') {
      db.updateHeartbeat = originalHeartbeat;
      watcher.publishHeartbeat();
      await watcher.heartbeatTail;
    } else if (command === 'short-status-timeout') {
      WatcherProcess.STATUS_TIMEOUT_MS = 3000;
    } else if (command === 'service-status') {
      value = await service.getStatus();
    } else if (command === 'tool-status') {
      let handler;
      registerIndexStatusTool({
        server: { registerTool: (_name, _schema, callback) => { handler = callback; } },
        systemState: { state: 'RUNNING', service },
        serverManager: {},
      });
      value = (await handler({})).content[0].text;
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
