import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { FileStorage } from '@search-docs/storage';
import { FileDiscovery } from '../file-discovery.js';
import { DocumentQueue } from '../../worker/document-queue.js';
import { reconcileStartup } from '../../watcher/startup-reconciliation.js';
import type { DBEngine } from '@search-docs/db-engine';

describe('startup reconciliation', () => {
  it('removes confirmed missing paths, skips stale requests and preserves ambiguous paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'startup-reconciliation-'));
    const project = join(root, 'project');
    const managed = join(root, 'managed');
    await mkdir(project); await mkdir(managed);
    const storage = new FileStorage({ basePath: managed });
    const doc = { path: '', content: '# test', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: '' } };
    try {
      for (const name of ['deleted.md', 'present.md', 'excluded.md', 'dangling.md']) await storage.save(name, { ...doc, path: name });
      await writeFile(join(project, 'present.md'), '# present');
      await symlink(join(project, 'missing-target'), join(project, 'dangling.md'));
      const db = {
        getIndexedPaths: vi.fn().mockResolvedValue(['index-only.md']),
        getPathsWithStatus: vi.fn().mockResolvedValue(['request-only.md']),
        updateManyIndexRequests: vi.fn().mockResolvedValue({ updated: true }),
        deleteSectionsByPath: vi.fn().mockResolvedValue({ deleted: true }),
      };
      const report = vi.fn();
      const discovery = new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: ['excluded.md'], respectGitignore: false, maxFileSize: 1000 } });
      await reconcileStartup({ root: project, storage, db: db as unknown as DBEngine, discovery, queue: new DocumentQueue(), covered: () => true, active: () => true, report });
      expect(await storage.get('deleted.md')).toBeNull();
      expect(await storage.get('present.md')).not.toBeNull();
      expect(await storage.get('excluded.md')).not.toBeNull();
      expect(await storage.get('dangling.md')).not.toBeNull();
      expect(db.deleteSectionsByPath.mock.calls.map(call => call[0]).sort()).toEqual(['deleted.md', 'index-only.md', 'request-only.md']);
      expect(db.updateManyIndexRequests).toHaveBeenCalledWith({ documentPath: 'deleted.md', status: 'processing' }, expect.objectContaining({ status: 'skipped' }));
      expect(report).toHaveBeenCalledWith(expect.stringContaining('excluded.md'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps all candidates if a storage symlink escapes or scanning fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'startup-reconciliation-'));
    const managed = join(root, 'managed'); const outside = join(root, 'outside'); const project = join(root, 'project');
    await mkdir(managed); await mkdir(outside); await mkdir(project);
    await symlink(outside, join(managed, 'link'));
    try {
      const db = { getIndexedPaths: vi.fn().mockResolvedValue(['a.md']), getPathsWithStatus: vi.fn().mockResolvedValue([]), deleteSectionsByPath: vi.fn() };
      const report = vi.fn();
      await reconcileStartup({ root: project, storage: new FileStorage({ basePath: managed }), db: db as unknown as DBEngine, discovery: new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: [], respectGitignore: false, maxFileSize: 1000 } }), queue: new DocumentQueue(), covered: () => true, active: () => true, report });
      expect(db.deleteSectionsByPath).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rechecks a recreated source after waiting for the document queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'startup-recreate-'));
    const project = join(root, 'project'); const managed = join(root, 'managed');
    await mkdir(project); await mkdir(managed);
    const storage = new FileStorage({ basePath: managed });
    await storage.save('a.md', { path: 'a.md', content: 'old', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: '' } });
    const queue = new DocumentQueue();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = queue.run('a.md', () => gate);
    const db = { getIndexedPaths: vi.fn().mockResolvedValue([]), getPathsWithStatus: vi.fn().mockResolvedValue([]), deleteSectionsByPath: vi.fn() };
    try {
      const work = reconcileStartup({ root: project, storage, db: db as unknown as DBEngine, discovery: new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: [], respectGitignore: false, maxFileSize: 1000 } }), queue, covered: () => true, active: () => true, report: vi.fn() });
      await vi.waitFor(() => expect(db.getIndexedPaths).toHaveBeenCalled());
      await writeFile(join(project, 'a.md'), 'new');
      release();
      await Promise.all([lock, work]);
      expect(db.deleteSectionsByPath).not.toHaveBeenCalled();
      expect(await storage.get('a.md')).not.toBeNull();
    } finally { release(); await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a document when an internal storage symlink aliases its parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'startup-storage-link-'));
    const project = join(root, 'project'); const managed = join(root, 'managed');
    await mkdir(project); await mkdir(managed); await mkdir(join(managed, 'real')); await mkdir(join(project, 'real')); await mkdir(join(project, 'alias'));
    await symlink(join(managed, 'real'), join(managed, 'alias'));
    await writeFile(join(project, 'real', 'a.md'), 'present');
    const storage = new FileStorage({ basePath: managed });
    await storage.save('real/a.md', { path: 'real/a.md', content: 'keep', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: '' } });
    const db = { getIndexedPaths: vi.fn().mockResolvedValue([]), getPathsWithStatus: vi.fn().mockResolvedValue([]), deleteSectionsByPath: vi.fn() };
    const report = vi.fn();
    try {
      await reconcileStartup({ root: project, storage, db: db as unknown as DBEngine, discovery: new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: [], respectGitignore: false, maxFileSize: 1000 } }), queue: new DocumentQueue(), covered: () => true, active: () => true, report });
      expect(await storage.get('real/a.md')).not.toBeNull();
      expect(db.deleteSectionsByPath).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(expect.stringContaining('alias/a.md'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['unwatched', 'missing-parent', 'scan-failure'])('holds a candidate when %s prevents a safe decision', async (condition) => {
    const root = await mkdtemp(join(tmpdir(), 'startup-deferred-'));
    const project = join(root, 'project'); const managed = join(root, 'managed');
    await mkdir(project); await mkdir(managed);
    const storage = new FileStorage({ basePath: managed });
    const candidate = condition === 'missing-parent' ? 'missing/a.md' : 'a.md';
    await storage.save(candidate, { path: candidate, content: 'keep', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: '' } });
    if (condition === 'scan-failure') vi.spyOn(storage, 'list').mockRejectedValue(new Error('injected scan failure'));
    const db = { getIndexedPaths: vi.fn().mockResolvedValue([]), getPathsWithStatus: vi.fn().mockResolvedValue([]), deleteSectionsByPath: vi.fn() };
    const report = vi.fn();
    try {
      await reconcileStartup({ root: project, storage, db: db as unknown as DBEngine, discovery: new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: [], respectGitignore: false, maxFileSize: 1000 } }), queue: new DocumentQueue(), covered: () => condition !== 'unwatched', active: () => true, report });
      expect(await storage.get(candidate)).not.toBeNull();
      expect(db.deleteSectionsByPath).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports an indexed nested path when the managed parent does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'startup-index-only-'));
    const project = join(root, 'project'); const managed = join(root, 'managed');
    await mkdir(project); await mkdir(managed); await mkdir(join(project, 'nested'));
    const db = { getIndexedPaths: vi.fn().mockResolvedValue(['nested/a.md']), getPathsWithStatus: vi.fn().mockResolvedValue([]), deleteSectionsByPath: vi.fn() };
    const report = vi.fn();
    try {
      await reconcileStartup({ root: project, storage: new FileStorage({ basePath: managed }), db: db as unknown as DBEngine, discovery: new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: [], respectGitignore: false, maxFileSize: 1000 } }), queue: new DocumentQueue(), covered: () => true, active: () => true, report });
      expect(db.deleteSectionsByPath).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(expect.stringContaining('nested/a.md'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['sections', 'copy'])('retries after a partial failure deleting %s', async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'startup-retry-'));
    const project = join(root, 'project'); const managed = join(root, 'managed');
    await mkdir(project); await mkdir(managed);
    const storage = new FileStorage({ basePath: managed });
    await storage.save('a.md', { path: 'a.md', content: 'old', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: '' } });
    let pending = true; let indexed = true;
    const db = {
      getIndexedPaths: vi.fn(async () => indexed ? ['a.md'] : []),
      getPathsWithStatus: vi.fn(async () => pending ? ['a.md'] : []),
      updateManyIndexRequests: vi.fn(async () => { pending = false; }),
      deleteSectionsByPath: vi.fn(async () => { if (failure === 'sections' && indexed) { indexed = false; throw new Error('injected sections failure'); } indexed = false; }),
    };
    if (failure === 'copy') {
      const original = storage.delete.bind(storage);
      vi.spyOn(storage, 'delete').mockImplementationOnce(async () => { throw new Error('injected copy failure'); }).mockImplementation(original);
    }
    const report = vi.fn();
    const options = { root: project, storage, db: db as unknown as DBEngine, discovery: new FileDiscovery({ rootDir: project, config: { sources: ['**/*.md'], exclude: [], respectGitignore: false, maxFileSize: 1000 } }), queue: new DocumentQueue(), covered: () => true, active: () => true, report };
    try {
      await reconcileStartup(options);
      expect(pending).toBe(false);
      expect(report).toHaveBeenCalledWith(expect.stringContaining('a.md'));
      expect(await storage.get('a.md')).not.toBeNull();
      await reconcileStartup(options);
      expect(indexed).toBe(false);
      expect(await storage.get('a.md')).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
