import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DBEngine, IndexRequest } from '@search-docs/db-engine';
import type { FileStorage } from '@search-docs/storage';
import type { SearchDocsConfig, Document, Section } from '@search-docs/types';
import { WatcherProcess } from '../../watcher/watcher-process.js';
import type { IndexWorker } from '../../worker/index-worker.js';
import { DocumentQueue } from '../../worker/document-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('indexing and deletion', () => {
  it('unblocks the next operation and drain after a failed write', async () => {
    const queue = new DocumentQueue();
    const entered = deferred();
    const release = deferred();
    const failed = queue.run('a.md', async () => {
      entered.resolve();
      await release.promise;
      throw new Error('write failed');
    });
    await entered.promise;
    const deletion = vi.fn(async () => {});
    const next = queue.run('a.md', deletion);
    const drained = queue.drain();
    release.resolve();
    await expect(failed).rejects.toThrow('write failed');
    await Promise.all([next, drained]);
    expect(deletion).toHaveBeenCalledOnce();
  });

  it('preserves deletion and recreation order when indexing is in progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'index-delete-race-'));
    try {
    const entered = deferred();
    const release = deferred();
    const request: IndexRequest = { id: '1', documentPath: 'a.md', documentHash: 'old', status: 'pending', createdAt: new Date().toISOString() };
    const requests = new Map<string, IndexRequest>([[request.id, request]]);
    let document: Document | null = { path: 'a.md', content: '# Old', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: 'old' } };
    let sections: Array<Omit<Section, 'vector'>> = [];
    const storage = { get: vi.fn(async () => document), delete: vi.fn(async () => { document = null; }), save: vi.fn(async (_path: string, doc: Document) => { document = doc; }) };
    const newRequests: Array<{ documentPath: string; documentHash: string }> = [];
    const db = {
      createIndexRequest: vi.fn(async (params: { documentPath: string; documentHash: string }) => { newRequests.push(params); }),
      updateIndexRequest: vi.fn(async (_id: string, updates: Partial<IndexRequest>) => { Object.assign(requests.get(_id)!, updates); }),
      updateManyIndexRequests: vi.fn(async () => 0),
      findSectionsByPathAndHash: vi.fn(async (_path: string, hash: string) => { if (hash === 'old') { entered.resolve(); await release.promise; } return sections.filter(section => section.documentHash === hash); }),
      addSections: vi.fn(async (added: Array<Omit<Section, 'vector'>>) => { sections.push(...added); }),
      deleteSectionsByPath: vi.fn(async () => { sections = []; }),
      deleteSectionsByPathExceptHash: vi.fn(async (_path: string, hash: string) => { sections = sections.filter(section => section.documentHash === hash); }),
    };
    const config = {
      project: { root }, files: { sources: ['**/*.md'], exclude: [], maxFileSize: 10000 },
      storage: { indexPath: join(root, 'index') },
      indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
      watcher: { enabled: false }, worker: { enabled: true },
    } as unknown as SearchDocsConfig;
    const watcher = new WatcherProcess(config, storage as unknown as FileStorage, db as unknown as DBEngine);
    const internal = watcher as unknown as { indexWorker: IndexWorker; handleFileChange: (event: { type: 'unlink' | 'add'; path: string }) => Promise<void> };
    const worker = internal.indexWorker as unknown as { processRequest: (request: IndexRequest) => Promise<void> };
    const indexing = worker.processRequest(request);
    await entered.promise;
    const deletion = internal.handleFileChange({ type: 'unlink', path: 'a.md' });
    await writeFile(join(root, 'a.md'), '# New');
    const addition = internal.handleFileChange({ type: 'add', path: 'a.md' });
    release.resolve();
    await Promise.all([indexing, deletion]);
    expect(request.status).toBe('completed');
    await addition;
    expect(document?.content).toBe('# New');
    expect(sections).toHaveLength(0);
    expect(newRequests).toHaveLength(1);
    expect(newRequests[0].documentHash).toBe(document?.metadata.fileHash);
    const newRequest: IndexRequest = { id: '2', ...newRequests[0], status: 'pending', createdAt: new Date().toISOString() };
    requests.set(newRequest.id, newRequest);
    await worker.processRequest(newRequest);
    expect(newRequest.status).toBe('completed');
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every(section => section.documentHash === newRequest.documentHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops an old worker before its next write after losing ownership', async () => {
    const entered = deferred();
    const release = deferred();
    const request: IndexRequest = { id: 'old', documentPath: 'a.md', documentHash: 'old', status: 'pending', createdAt: new Date().toISOString() };
    let document: Document | null = { path: 'a.md', content: '# Old', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: 'old' } };
    let sections: Array<Omit<Section, 'vector'>> = [];
    const storage = { get: async () => document, delete: async () => { document = null; } };
    const db = {
      updateIndexRequest: async (_id: string, updates: Partial<IndexRequest>) => { Object.assign(request, updates); },
      updateManyIndexRequests: async () => 0,
      findSectionsByPathAndHash: async () => { entered.resolve(); await release.promise; return []; },
      addSections: async (added: Array<Omit<Section, 'vector'>>) => { sections.push(...added); },
      deleteSectionsByPath: async () => { sections = []; },
      deleteSectionsByPathExceptHash: async () => {},
    };
    const config = {
      project: { root: process.cwd() }, files: { sources: ['**/*.md'], exclude: [], maxFileSize: 10000 },
      storage: { indexPath: join(tmpdir(), 'index-delete-race-test') },
      indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3, vectorDimension: 256, embeddingModel: 'test' },
      watcher: { enabled: false }, worker: { enabled: true },
    } as unknown as SearchDocsConfig;
    const oldWriter = new WatcherProcess(config, storage as unknown as FileStorage, db as unknown as DBEngine);
    const newWriter = new WatcherProcess(config, storage as unknown as FileStorage, db as unknown as DBEngine);
    const old = oldWriter as unknown as { writerState: string; transitionToSleeping: () => Promise<void>; indexWorker: { processRequest: (request: IndexRequest) => Promise<void> } };
    const next = newWriter as unknown as { handleFileChange: (event: { type: 'unlink'; path: string }) => Promise<void> };
    old.writerState = 'watching';
    const indexing = old.indexWorker.processRequest(request);
    await entered.promise;
    await old.transitionToSleeping();
    await next.handleFileChange({ type: 'unlink', path: 'a.md' });
    release.resolve();
    await indexing;
    expect(document).toBeNull();
    expect(request.status).toBe('processing');
    expect(sections).toHaveLength(0);
  });


});
