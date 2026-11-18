import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DBEngine } from '@search-docs/db-engine';
import { FileStorage } from '@search-docs/storage';
import type { SearchDocsConfig } from '@search-docs/types';
import { WatcherProcess } from '../watcher/watcher-process.js';
import { IndexWorker } from '../worker/index-worker.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('index deletion with LanceDB', () => {
  it('serializes deletion and recreation, then recovers a request after a clean handover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'index-delete-db-'));
    const project = join(root, 'project');
    await mkdir(project);
    const entered = deferred();
    const release = deferred();
    const enteredAgain = deferred();
    const releaseAgain = deferred();
    let calls = 0;
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') { res.end(JSON.stringify({ model: 'test', vectorDimension: 256 })); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
      calls++;
      if (calls === 1) { entered.resolve(); await release.promise; }
      if (calls === 2) { enteredAgain.resolve(); await releaseAgain.promise; }
      res.end(JSON.stringify({ embeddings: input.input.map(() => Array(256).fill(0.1)) }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const db1 = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
    const db2 = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
    const storage = new FileStorage({ basePath: join(root, 'documents') });
    const config = {
      version: '1.0', project: { name: 'test', root: project },
      files: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 100000 },
      indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
      watcher: { enabled: false, debounceMs: 10, awaitWriteFinishMs: 10 },
      worker: { enabled: true, interval: 60000, maxConcurrent: 1 },
    } as unknown as SearchDocsConfig;
    let old: WatcherProcess | undefined;
    let next: WatcherProcess | undefined;
    try {
      await db1.connect();
      await db2.connect();
      old = new WatcherProcess(config, storage, db1);
      const oi = old as unknown as {
        writerId: string; writerState: string; indexWorker: IndexWorker;
        handleFileChange: (event: { type: 'add' | 'unlink'; path: string }) => Promise<void>;
      };
      oi.writerState = 'watching';
      await db1.claimWriter({ writerId: oi.writerId, host: 'test', pid: process.pid });
      await writeFile(join(project, 'a.md'), '# Old');
      await oi.handleFileChange({ type: 'add', path: 'a.md' });
      const indexing = oi.indexWorker.processNextRequests();
      await entered.promise;
      let deleted = false;
      const deletion = oi.handleFileChange({ type: 'unlink', path: 'a.md' }).then(() => { deleted = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(deleted).toBe(false);
      release.resolve();
      await Promise.all([indexing, deletion]);
      expect((await db1.getSectionsByPath('a.md')).sections).toHaveLength(0);
      expect(await storage.get('a.md')).toBeNull();
      await writeFile(join(project, 'a.md'), '# New');
      await oi.handleFileChange({ type: 'add', path: 'a.md' });
      const pending = await db1.findIndexRequests({ status: 'pending' });
      expect(pending).toHaveLength(1);
      const indexingAgain = oi.indexWorker.processNextRequests();
      await enteredAgain.promise;
      let stopped = false;
      const stopping = old.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      releaseAgain.resolve();
      await Promise.all([indexingAgain, stopping]);
      old = undefined;
      expect((await db2.findIndexRequests({ status: 'processing' })).some(r => r.id === pending[0].id)).toBe(true);
      expect((await db2.getWriterHeartbeat()).exists).toBe(false);
      const config2 = { ...config, worker: { ...config.worker, enabled: false } };
      next = new WatcherProcess(config2, storage, db2);
      const ni = next as unknown as {
        writerId: string; transitionToWatching: () => Promise<void>;
        startupSyncWorker: { startSync: () => void; waitForSync: () => Promise<void> };
        splitter: ConstructorParameters<typeof IndexWorker>[0]['splitter'];
      };
      ni.startupSyncWorker = { startSync: () => {}, waitForSync: async () => {} };
      await db2.claimWriter({ writerId: ni.writerId, host: 'test', pid: process.pid });
      await ni.transitionToWatching();
      expect((await db2.findIndexRequests({ status: 'pending' })).some(r => r.id === pending[0].id)).toBe(true);
      const worker = new IndexWorker({ dbEngine: db2, storage, splitter: ni.splitter });
      await worker.processNextRequests();
      expect((await db2.findIndexRequests({ status: 'completed' })).some(r => r.id === pending[0].id)).toBe(true);
      const sections = (await db2.getSectionsByPath('a.md')).sections;
      expect(sections.length).toBeGreaterThan(0);
      expect(sections.every(s => s.documentHash === pending[0].documentHash)).toBe(true);
      expect((await storage.get('a.md'))?.content).toBe('# New');
    } finally {
      release.resolve();
      releaseAgain.resolve();
      if (old) await old.stop(); else db1.disconnect();
      if (next) await next.stop(); else db2.disconnect();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
