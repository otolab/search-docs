import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
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
      storage: { indexPath: join(root, 'db') },
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

it('hands over between independent Node writers using the same LanceDB', async () => {
  const { fork } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'writer-process-db-'));
  const project = join(root, 'project');
  await mkdir(project);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ model: 'test', vectorDimension: 256 })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    res.end(JSON.stringify({ embeddings: input.input.map(() => Array(256).fill(0.1)) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const children = [0, 1].map(() => fork(join(process.cwd(), 'src/__tests__/fixtures/issue150-writer.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  let sequence = 0;
  const invoke = (child: typeof children[number], command: string, args: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`${command} timed out`)); }, 15000);
    const receive = (message: { id: number; value?: unknown; error?: string }) => {
      if (message.id !== id) return;
      clearTimeout(timer); child.off('message', receive);
      if (message.error) reject(new Error(message.error)); else resolve(message.value);
    };
    child.on('message', receive);
    child.send({ id, command, args });
  });
  try {
    const args = { project, dbPath: join(root, 'db'), storagePath: join(root, 'documents'), embeddingUrl: `http://127.0.0.1:${port}` };
    await invoke(children[0], 'init', args);
    await invoke(children[1], 'init', args);
    expect(children[0].pid).not.toBe(children[1].pid);
    await invoke(children[0], 'claim');
    await writeFile(join(project, 'a.md'), '# Old');
    await invoke(children[0], 'event', { type: 'add', path: 'a.md' });
    await invoke(children[0], 'run');
    expect((await invoke(children[0], 'inspect')).sections.length).toBeGreaterThan(0);
    await invoke(children[0], 'event', { type: 'unlink', path: 'a.md' });
    const deleted = await invoke(children[0], 'inspect');
    expect(deleted.sections).toHaveLength(0);
    expect(deleted.document).toBeNull();
    await writeFile(join(project, 'a.md'), '# New');
    await invoke(children[0], 'event', { type: 'add', path: 'a.md' });
    const requestId = await invoke(children[0], 'processing');
    await invoke(children[0], 'stop');
    await invoke(children[0], 'exit');
    await invoke(children[1], 'claim');
    const recovered = await invoke(children[1], 'inspect');
    expect(recovered.requests.find((r: { id: string }) => r.id === requestId).status).toBe('pending');
    await invoke(children[1], 'run');
    const result = await invoke(children[1], 'inspect');
    expect(result.requests.find((r: { id: string }) => r.id === requestId).status).toBe('completed');
    expect(result.document.content).toBe('# New');
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections.every((s: { documentHash: string }) => s.documentHash === result.document.metadata.fileHash)).toBe(true);
    await invoke(children[1], 'stop');
    await invoke(children[1], 'exit');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it('drains a debounced deletion through the MCP stopService entry point', async () => {
  const mcpStatePath = '../../../mcp-server/dist/' + 'state.js';
  const { stopService } = await import(mcpStatePath);
  const root = await mkdtemp(join(tmpdir(), 'mcp-stop-db-'));
  const project = join(root, 'project');
  await mkdir(project);
  const file = join(project, 'a.md');
  await writeFile(file, '# Old');
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ model: 'test', vectorDimension: 256 })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    res.end(JSON.stringify({ embeddings: input.input.map(() => Array(256).fill(0.1)) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const db = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
  const observer = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
  const storage = new FileStorage({ basePath: join(root, 'documents') });
  const config = {
    project: { name: 'test', root: project },
    files: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 100000 },
    indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
    storage: { indexPath: join(root, 'db') },
    watcher: { enabled: true, debounceMs: 5000, awaitWriteFinishMs: 50 },
    worker: { enabled: true, interval: 100, maxConcurrent: 1 },
  } as unknown as SearchDocsConfig;
  const constants = WatcherProcess as unknown as Record<string, number>;
  const jitter = constants.CLAIM_JITTER_MAX_MS;
  const delay = constants.CLAIM_READBACK_DELAY_MS;
  constants.CLAIM_JITTER_MAX_MS = 0;
  constants.CLAIM_READBACK_DELAY_MS = 0;
  let stopped = false;
  const watcher = new WatcherProcess(config, storage, db);
  try {
    watcher.start();
    await vi.waitFor(async () => expect((await db.getSectionsByPath('a.md')).sections.length).toBeGreaterThan(0), { timeout: 15000 });
    await import('node:fs/promises').then(fs => fs.unlink(file));
    const internal = watcher as unknown as { watcher: { debounceTimers: Map<string, { type: string }> } };
    await vi.waitFor(() => expect([...internal.watcher.debounceTimers.values()].some(event => event.type === 'unlink')).toBe(true), { timeout: 5000 });
    await stopService({ watcherProcess: watcher, dbEngine: db, service: { stop() {} }, embeddingServer: { shutdown() {} } } as never);
    stopped = true;
    await observer.connect();
    expect((await observer.getSectionsByPath('a.md')).sections).toHaveLength(0);
    expect(await storage.get('a.md')).toBeNull();
    expect((await observer.getWriterHeartbeat()).exists).toBe(false);
    const restartedDb = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
    const restarted = new WatcherProcess(config, storage, restartedDb);
    try {
      restarted.start();
      await vi.waitFor(() => expect(restarted.getStatus().writerState).toBe('watching'), { timeout: 10000 });
      await restarted.stop();
      const checkDb = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
      try {
        await checkDb.connect();
        expect((await checkDb.getSectionsByPath('a.md')).sections).toHaveLength(0);
        expect(await storage.get('a.md')).toBeNull();
      } finally {
        checkDb.disconnect();
      }
    } finally {
      restartedDb.disconnect();
    }
  } finally {
    if (!stopped) await watcher.stop();
    observer.disconnect();
    constants.CLAIM_JITTER_MAX_MS = jitter;
    constants.CLAIM_READBACK_DELAY_MS = delay;
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it('recovers automatically in another process after writer release fails', async () => {
  const { fork } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'writer-release-failure-'));
  const project = join(root, 'project');
  await mkdir(project);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ model: 'test', vectorDimension: 256 })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    res.end(JSON.stringify({ embeddings: input.input.map(() => Array(256).fill(0.1)) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const children = [0, 1].map(() => fork(join(process.cwd(), 'src/__tests__/fixtures/issue150-writer.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  let sequence = 0;
  const invoke = (child: typeof children[number], command: string, args: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`${command} timed out`)); }, 15000);
    const receive = (message: { id: number; value?: unknown; error?: string }) => {
      if (message.id !== id) return;
      clearTimeout(timer); child.off('message', receive);
      if (message.error) reject(new Error(message.error)); else resolve(message.value);
    };
    child.on('message', receive);
    child.send({ id, command, args });
  });
  try {
    const args = { project, dbPath: join(root, 'db'), storagePath: join(root, 'documents'), embeddingUrl: `http://127.0.0.1:${port}` };
    await invoke(children[0], 'init', args);
    await invoke(children[1], 'init', args);
    expect(children[0].pid).not.toBe(children[1].pid);
    const oldWriter = await invoke(children[0], 'claim');
    await writeFile(join(project, 'a.md'), '# Recovery');
    await invoke(children[0], 'event', { type: 'add', path: 'a.md' });
    const requestId = await invoke(children[0], 'processing');
    const initial = await invoke(children[1], 'coordinate');
    expect(initial.writerState).toBe('sleeping');
    await invoke(children[1], 'short-status-timeout');
    const uncertainty = 'writer の照合・監視状態を確認できません';
    await invoke(children[0], 'legacy-heartbeat');
    expect(await invoke(children[1], 'tool-status')).toContain(uncertainty);
    await invoke(children[0], 'clean-warning');
    let output = await invoke(children[1], 'tool-status');
    expect(output).toContain('照合・監視: 正常');
    expect(output).not.toContain(uncertainty);
    expect(output).not.toContain('injected deferred reconciliation');
    for (const count of [10, 100, 500]) {
      const bulk = await invoke(children[0], 'many-warnings', { count });
      console.log(`[issue150] ${count} warning heartbeat measurement:`, bulk);
      expect(bulk.updates).toBeLessThanOrEqual(2);
      expect(bulk.bytes).toBeLessThan(20000);
      if (count < 500) await invoke(children[0], 'clean-warning');
    }
    output = await invoke(children[1], 'tool-status');
    expect(output).toContain('docs/0.md');
    expect(output).toContain('監視範囲を確認できません');
    expect(output).toContain('475 件');
    await invoke(children[0], 'clean-warning');
    await invoke(children[0], 'fail-warning-publication');
    await vi.waitFor(async () => {
      const text = await invoke(children[1], 'tool-status');
      expect(text).toContain(uncertainty);
      expect(text).not.toContain('照合・監視: 正常');
    }, { timeout: 10000, interval: 250 });
    await invoke(children[0], 'restore-publication');
    output = await invoke(children[1], 'tool-status');
    expect(output).toContain('injected deferred reconciliation');
    expect(output).not.toContain(uncertainty);
    expect(output).not.toContain('照合・監視: 正常');
    await invoke(children[0], 'clean-warning');
    output = await invoke(children[1], 'tool-status');
    expect(output).not.toContain(uncertainty);
    expect(output).not.toContain('injected deferred reconciliation');
    expect(output).toContain('照合・監視: 正常');
    await expect(invoke(children[0], 'fail-release-stop')).rejects.toThrow('injected writer release failure');
    const stillOwned = await invoke(children[1], 'status');
    expect(stillOwned.heartbeat.heartbeat.writerId).toBe(oldWriter);
    await vi.waitFor(async () => {
      const result = await invoke(children[1], 'status');
      expect(result.status.writerState).toBe('watching');
      expect(result.heartbeat.heartbeat.writerId).toBe(result.status.writerId);
    }, { timeout: 20000, interval: 250 });
    output = await invoke(children[1], 'tool-status');
    expect(output).not.toContain(uncertainty);
    const recovered = await invoke(children[1], 'inspect');
    expect(recovered.requests.find((r: { id: string }) => r.id === requestId).status).toBe('pending');
    await invoke(children[1], 'run');
    const completed = await invoke(children[1], 'inspect');
    expect(completed.requests.find((r: { id: string }) => r.id === requestId).status).toBe('completed');
    expect(completed.document.content).toBe('# Recovery');
    expect(completed.sections.length).toBeGreaterThan(0);
    await invoke(children[1], 'stop');
    await invoke(children[1], 'exit');
    await invoke(children[0], 'exit');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it('reconciles missing and index-only documents after a real watcher starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup-reconcile-db-'));
  const project = join(root, 'project'); await mkdir(project);
  const embedding = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ model: 'test', vectorDimension: 256 })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    res.end(JSON.stringify({ embeddings: input.input.map(() => Array(256).fill(0.1)) }));
  });
  embedding.listen(0, '127.0.0.1'); await once(embedding, 'listening');
  const port = (embedding.address() as { port: number }).port;
  const db = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
  const storage = new FileStorage({ basePath: join(root, 'documents') });
  const config = {
    version: '1.0', project: { name: 'test', root: project },
    files: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 100000 },
    indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
    storage: { indexPath: join(root, 'db') },
    watcher: { enabled: true, debounceMs: 10, awaitWriteFinishMs: 10 },
    worker: { enabled: true, interval: 60000, maxConcurrent: 1 },
  } as unknown as SearchDocsConfig;
  let watcher: WatcherProcess | undefined;
  try {
    await db.connect();
    watcher = new WatcherProcess(config, storage, db);
    const inner = watcher as unknown as {
      writerId: string; indexWorker: IndexWorker;
      handleFileChange: (event: { type: 'add'; path: string }) => Promise<void>;
      transitionToWatching: () => Promise<void>;
      transitionToSleeping: () => Promise<void>;
      startupSyncWorker: { waitForSync: () => Promise<void> };
    };
    await db.claimWriter({ writerId: inner.writerId, host: 'test', pid: process.pid });
    for (const name of ['missing.md', 'index-only.md', 'race.md', 'retry-sections.md', 'retry-copy.md']) {
      await writeFile(join(project, name), '# old');
      await inner.handleFileChange({ type: 'add', path: name });
    }
    await inner.indexWorker.processNextRequests();
    expect((await db.getSectionsByPath('index-only.md')).sections.length).toBeGreaterThan(0);
    await rm(join(project, 'missing.md')); await rm(join(project, 'index-only.md')); await rm(join(project, 'race.md'));
    await rm(join(project, 'retry-sections.md')); await rm(join(project, 'retry-copy.md'));
    await storage.delete('index-only.md');
    const pending = await db.createIndexRequest({ documentPath: 'missing.md', documentHash: 'stale' });
    await db.updateIndexRequest(pending.id, { status: 'processing' });
    const retryRequests = [];
    for (const documentPath of ['retry-sections.md', 'retry-copy.md']) {
      retryRequests.push(await db.createIndexRequest({ documentPath, documentHash: 'stale' }));
    }
    for (const request of retryRequests) await db.updateIndexRequest(request.id, { status: 'processing' });
    const originalUpdate = db.updateManyIndexRequests.bind(db);
    let recreated = false;
    vi.spyOn(db, 'updateManyIndexRequests').mockImplementation(async (filter, updates) => {
      if (filter.documentPath === 'race.md' && !recreated) {
        recreated = true;
        await writeFile(join(project, 'race.md'), '# fresh');
      }
      return originalUpdate(filter, updates);
    });
    const originalDeleteSections = db.deleteSectionsByPath.bind(db);
    let failSections = true;
    vi.spyOn(db, 'deleteSectionsByPath').mockImplementation(async name => {
      if (name === 'retry-sections.md' && failSections) { failSections = false; throw new Error('injected sections failure'); }
      return originalDeleteSections(name);
    });
    const originalDeleteCopy = storage.delete.bind(storage);
    let failCopy = true;
    vi.spyOn(storage, 'delete').mockImplementation(async name => {
      if (name === 'retry-copy.md' && failCopy) { failCopy = false; throw new Error('injected copy failure'); }
      return originalDeleteCopy(name);
    });
    await inner.transitionToWatching();
    await inner.startupSyncWorker.waitForSync();
    expect((await db.getSectionsByPath('missing.md')).sections).toHaveLength(0);
    expect((await db.getSectionsByPath('index-only.md')).sections).toHaveLength(0);
    expect(await storage.get('missing.md')).toBeNull();
    expect((await db.findIndexRequests({ documentPath: 'missing.md' })).find(r => r.id === pending.id)?.status).toBe('skipped');
    expect(watcher.getStatus().reconciliationWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('retry-sections.md'), expect.stringContaining('retry-copy.md'),
    ]));
    expect(await storage.get('retry-sections.md')).not.toBeNull();
    expect(await storage.get('retry-copy.md')).not.toBeNull();
    expect((await db.getSectionsByPath('retry-sections.md')).sections.length).toBeGreaterThan(0);
    expect((await db.getSectionsByPath('retry-copy.md')).sections).toHaveLength(0);
    for (const request of retryRequests) {
      expect((await db.findIndexRequests({ documentPath: request.documentPath })).find(r => r.id === request.id)?.status).toBe('skipped');
    }
    await inner.transitionToSleeping();
    await inner.transitionToWatching();
    await inner.startupSyncWorker.waitForSync();
    for (const name of ['retry-sections.md', 'retry-copy.md']) {
      expect(await storage.get(name)).toBeNull();
      expect((await db.getSectionsByPath(name)).sections).toHaveLength(0);
    }
    expect(watcher.getStatus().reconciliationWarnings).toEqual([]);
    await vi.waitFor(async () => expect((await storage.get('race.md'))?.content).toBe('# fresh'), { timeout: 10000, interval: 100 });
    await inner.indexWorker.processNextRequests();
    expect((await db.getSectionsByPath('race.md')).sections.length).toBeGreaterThan(0);
    const freshHash = (await storage.get('race.md'))?.metadata.fileHash;
    expect((await db.getSectionsByPath('race.md')).sections.every(s => s.documentHash === freshHash)).toBe(true);
  } finally {
    if (watcher) await watcher.stop(); else db.disconnect();
    embedding.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it('measures asynchronous deferred reconciliation with LanceDB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-many-db-'));
  const project = join(root, 'project');
  const documents = join(root, 'documents');
  await mkdir(project); await mkdir(documents);
  const { symlink } = await import('node:fs/promises');
  const count = 200;
  for (let i = 0; i < count; i++) {
    const name = `held-${i}.md`;
    await symlink('missing-target', join(project, name));
    await writeFile(join(documents, `${name}.json`), '{}');
  }
  const embedding = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ model: 'test', vectorDimension: 256 })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    res.end(JSON.stringify({ embeddings: input.input.map(() => Array(256).fill(0.1)) }));
  });
  embedding.listen(0, '127.0.0.1'); await once(embedding, 'listening');
  const port = (embedding.address() as { port: number }).port;
  const db = new DBEngine({ dbPath: join(root, 'db'), embeddingUrl: `http://127.0.0.1:${port}` });
  const storage = new FileStorage({ basePath: documents });
  const config = {
    version: '1.0', project: { name: 'test', root: project },
    files: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 100000 },
    indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
    storage: { indexPath: join(root, 'db') },
    watcher: { enabled: true, debounceMs: 10, awaitWriteFinishMs: 10 },
    worker: { enabled: true, interval: 60000, maxConcurrent: 1 },
  } as unknown as SearchDocsConfig;
  let watcher: WatcherProcess | undefined;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await db.connect();
    watcher = new WatcherProcess(config, storage, db);
    const inner = watcher as unknown as {
      writerId: string; indexWorker: IndexWorker;
      transitionToWatching: () => Promise<void>;
      startupSyncWorker: { waitForSync: () => Promise<void> };
      handleFileChange: (event: { type: 'add'; path: string }) => Promise<void>;
    };
    await db.claimWriter({ writerId: inner.writerId, host: 'test', pid: process.pid });
    let updates = 0; let bytes = 0;
    const originalUpdate = db.updateHeartbeat.bind(db);
    vi.spyOn(db, 'updateHeartbeat').mockImplementation(async data => {
      updates++; bytes += Buffer.byteLength(JSON.stringify(data));
      return originalUpdate(data);
    });
    let warningCount = 0;
    let concurrentIndex: Promise<void> | undefined;
    let addedDuringSync = false;
    warn.mockImplementation(message => {
      if (String(message).includes('起動時照合を保留しました:') && ++warningCount === 20) {
        addedDuringSync = true;
        concurrentIndex = writeFile(join(project, 'live.md'), '# Live')
          .then(() => inner.handleFileChange({ type: 'add', path: 'live.md' }));
      }
    });
    const started = performance.now();
    await inner.transitionToWatching();
    await inner.startupSyncWorker.waitForSync();
    await concurrentIndex;
    const elapsed = performance.now() - started;
    await vi.waitFor(async () => {
      const result = await db.getWriterHeartbeat();
      expect(result.heartbeat?.warnings?.join(' ')).toContain(`${count - 25} 件`);
    }, { timeout: 10000 });
    expect(updates).toBeLessThanOrEqual(5 + 2 * Math.ceil(elapsed / 250));
    const actualWarnings = warn.mock.calls.filter(call => String(call[0]).includes('起動時照合を保留しました:'));
    expect(actualWarnings).toHaveLength(count);
    expect(addedDuringSync).toBe(true);
    await inner.indexWorker.processNextRequests();
    await vi.waitFor(async () => {
      expect((await db.getSectionsByPath('live.md')).sections.length).toBeGreaterThan(0);
    }, { timeout: 10000 });
    const stopStarted = performance.now();
    await watcher.stop(); watcher = undefined;
    const stopMs = performance.now() - stopStarted;
    console.log('[issue150] asynchronous reconciliation measurement', { count, updates, bytes, elapsedMs: Math.round(elapsed), stopMs: Math.round(stopMs) });
  } finally {
    warn.mockRestore();
    if (watcher) await watcher.stop(); else db.disconnect();
    embedding.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
