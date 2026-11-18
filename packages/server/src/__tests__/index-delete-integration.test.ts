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
    await expect(invoke(children[0], 'fail-release-stop')).rejects.toThrow('injected writer release failure');
    const stillOwned = await invoke(children[1], 'status');
    expect(stillOwned.heartbeat.heartbeat.writerId).toBe(oldWriter);
    await vi.waitFor(async () => {
      const result = await invoke(children[1], 'status');
      expect(result.status.writerState).toBe('watching');
      expect(result.heartbeat.heartbeat.writerId).toBe(result.status.writerId);
    }, { timeout: 20000, interval: 250 });
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
