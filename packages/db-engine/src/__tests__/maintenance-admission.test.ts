import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MaintenanceLock, strictMaintenanceLock } from '../typescript/maintenance-lock.js';

const files = { sources: ['**/*.md'], exclude: [], maxFileSize: 1024, respectGitignore: true };

describe('maintenance admission', () => {
  it('serializes admission while allowing shared registrations', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'search-docs-admission-'));
    try {
      const first = new MaintenanceLock(directory);
      const second = new MaintenanceLock(directory);
      const shared1 = await first.acquireShared();
      const shared2 = await second.acquireShared();
      const release = await first.acquireAdmission();
      await expect(second.acquireAdmission({ timeoutMs: 0 })).rejects.toThrow(/タイムアウト/);
      await expect(second.acquireExclusive()).rejects.toThrow(/使用中/);
      const waiting = second.acquireAdmission({ timeoutMs: 1000 });
      await release();
      const next = await waiting;
      await next();
      await shared1();
      await shared2();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('同じ保存先への異なる project root を同時に許可せず、解放後は利用できる', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'search-docs-identity-'));
    try {
      const root1 = path.join(directory, 'one');
      const root2 = path.join(directory, 'two');
      const parent = path.join(directory, 'data');
      await Promise.all([mkdir(root1), mkdir(root2), mkdir(parent)]);
      const layout = { indexPath: path.join(parent, 'index'), documentsPath: path.join(parent, 'documents'), files };
      const first = await strictMaintenanceLock({ projectRoot: root1, ...layout });
      const same = await strictMaintenanceLock({ projectRoot: root1, ...layout });
      const other = await strictMaintenanceLock({ projectRoot: root2, ...layout });
      const otherSources = await strictMaintenanceLock({ projectRoot: root1, ...layout, files: { ...files, sources: ['docs/*.md'] } });
      const release1 = await first.acquireShared();
      const release2 = await same.acquireShared();
      await expect(other.acquireShared()).rejects.toThrow(/異なるプロジェクト設定/);
      await expect(otherSources.acquireShared()).rejects.toThrow(/異なるプロジェクト設定/);
      await release1();
      await release2();
      const releaseOther = await other.acquireShared();
      await releaseOther();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('非標準配置と保存先の symlink を拒否する', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'search-docs-layout-'));
    try {
      const parent = path.join(directory, 'data');
      await mkdir(parent);
      await mkdir(path.join(directory, 'other'));
      await symlink(path.join(directory, 'other'), path.join(parent, 'index'));
      await expect(strictMaintenanceLock({ projectRoot: directory, indexPath: 'data/wrong', documentsPath: 'data/documents', files })).rejects.toThrow(/兄弟配置/);
      await expect(strictMaintenanceLock({ projectRoot: directory, indexPath: 'data/index', documentsPath: 'data/documents', files })).rejects.toThrow(/通常のディレクトリ/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
