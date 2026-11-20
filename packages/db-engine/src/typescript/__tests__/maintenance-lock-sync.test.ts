import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({ failSync: false, paths: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (target: string, flags: string) => {
    const handle = await actual.open(target, flags);
    state.paths.push(target);
    return { sync: async () => { if (state.failSync) throw new Error('fsync failed'); await handle.sync(); }, close: () => handle.close() };
  } };
});
import { MaintenanceLock } from '../maintenance-lock.js';

const roots: string[] = [];
afterEach(async () => { state.failSync = false; state.paths = []; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('未完了マーカーの同期', () => {
  it('管理領域の親とマーカーの親を同期し、完了時もマーカーの親を同期する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maintenance-sync-'));
    roots.push(root);
    const directory = path.join(root, 'control');
    const lease = await new MaintenanceLock(directory).acquireExclusive();
    await lease.markIncomplete();
    expect(state.paths).toEqual([root, directory]);
    await lease.complete();
    expect(state.paths).toEqual([root, directory, directory]);
    await lease.release();
  });
  it('完了状態の同期に失敗すると排他を残す', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maintenance-sync-'));
    roots.push(root);
    const lock = new MaintenanceLock(path.join(root, 'control'));
    const lease = await lock.acquireExclusive();
    await lease.markIncomplete();
    state.failSync = true;
    await expect(lease.complete()).rejects.toThrow('fsync failed');
    await expect(lease.release()).rejects.toThrow(/ロックを保持/);
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
  });
});
