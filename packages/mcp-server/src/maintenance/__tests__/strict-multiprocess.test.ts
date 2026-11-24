import { describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileStorage } from '@search-docs/storage';
import { strictMaintenanceLock } from '@search-docs/db-engine';
import { DEFAULT_CONFIG } from '@search-docs/types';

interface Reply {
  id?: number;
  ready?: boolean;
  error?: string;
  result?: unknown;
}

function service(config: unknown): {
  child: ChildProcess;
  ready: Promise<void>;
  request: (action: string) => Promise<unknown>;
} {
  const child = fork(path.resolve('test-fixtures/strict-service-process.mjs'), [JSON.stringify(config)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, UV_NO_SYNC: '1', UV_CACHE_DIR: '/tmp/search-docs-uv-cache' },
  });
  let log = '';
  child.stderr?.on('data', chunk => { log = (log + String(chunk)).slice(-30000); });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('message', (message: Reply) => {
    if (message.ready) readyResolve();
    if (message.error && message.id === undefined) readyReject(new Error(`${message.error}\n${log}`));
    if (message.id !== undefined) {
      const reply = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reply?.reject(new Error(message.error));
      else reply?.resolve(message.result);
    }
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`service exited: ${code ?? signal}\n${log}`);
    readyReject(error);
    for (const reply of pending.values()) reply.reject(error);
    pending.clear();
  });
  return {
    child,
    ready,
    request: action => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.send({ id, action }, error => { if (error) { pending.delete(id); reject(error); } });
    }),
  };
}

describe.skipIf(process.platform === 'win32')('複数プロセスの strict サービス', () => {
  it('初期診断と repair を調停し、writer 停止後に別プロセスが昇格する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'strict-multiprocess-'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs/first.md'), '# first\n');
    const http = createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ready') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', ready: true, model: 'test', vectorDimension: 256 }));
      } else if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; dimensions: number };
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            embeddings: body.input.map(() => Array.from({ length: body.dimensions }, (_, i) => i === 0 ? 1 : 0)),
          }));
        });
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    const url = `http://127.0.0.1:${address.port}`;
    const config = {
      ...DEFAULT_CONFIG,
      project: { name: 'multiprocess-test', root },
      files: { ...DEFAULT_CONFIG.files, sources: ['docs/**/*.md'], respectGitignore: false },
      indexing: { ...DEFAULT_CONFIG.indexing, embeddingUrl: url },
      worker: { ...DEFAULT_CONFIG.worker, interval: 200 },
      watcher: { ...DEFAULT_CONFIG.watcher, debounceMs: 100, awaitWriteFinishMs: 100 },
    };
    const previousEmbeddingUrl = process.env.EMBEDDING_URL;
    process.env.EMBEDDING_URL = url;
    const lock = await strictMaintenanceLock({ projectRoot: root, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath, files: config.files });
    const first = service(config);
    let second: ReturnType<typeof service> | undefined;
    try {
      await first.ready;
      await vi.waitFor(async () => expect((await first.request('status') as { writerState: string }).writerState).toBe('watching'), { timeout: 30000, interval: 250 });
      const admission = await lock.acquireAdmission();
      try {
        second = service(config);
        let started = false;
        void second.ready.then(() => { started = true; }, () => {});
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(started).toBe(false);
      } finally { await admission(); }
      await second!.ready;
      await vi.waitFor(async () => expect((await second!.request('status') as { writerState: string }).writerState).toBe('sleeping'), { timeout: 15000, interval: 250 });
      const repairAdmission = await lock.acquireAdmission();
      const repair = second!.request('repair');
      try {
        let finished = false;
        void repair.then(() => { finished = true; }, () => {});
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(finished).toBe(false);
      } finally { await repairAdmission(); }
      await expect(repair).resolves.toBeDefined();
      await first.request('stop');
      await vi.waitFor(async () => expect((await second!.request('status') as { writerState: string }).writerState).toBe('watching'), { timeout: 75000, interval: 250 });
      await writeFile(path.join(root, 'docs/after.md'), '# after\n');
      const storage = new FileStorage({ basePath: path.join(root, '.search-docs/documents') });
      await vi.waitFor(async () => expect((await storage.get('docs/after.md'))?.content).toContain('after'), { timeout: 30000, interval: 250 });
      await second!.request('stop');
    } finally {
      for (const item of [first, second]) {
        if (item && item.child.exitCode === null && item.child.signalCode === null && item.child.connected) {
          await Promise.race([
            item.request('stop').catch(() => {}),
            new Promise<void>(resolve => setTimeout(resolve, 10000)),
          ]);
        }
      }
      if (previousEmbeddingUrl === undefined) delete process.env.EMBEDDING_URL;
      else process.env.EMBEDDING_URL = previousEmbeddingUrl;
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      if ([first, second].every(item => !item || !item.child.connected)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 180000);
});
