import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MaintenanceLock } from '@search-docs/db-engine';
import { runPurgeTransaction } from '../purge-transaction.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe.skipIf(process.platform === 'win32')('未公開の CLI purge', () => {
  it('排他中に削除し、失敗時は未完了を残して再 purge を拒否する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cli-purge-'));
    roots.push(root);
    const base = path.join(root, '.search-docs');
    await mkdir(path.join(base, 'index'), { recursive: true });
    await writeFile(path.join(base, 'index', 'data'), 'keep');
    const lock = new MaintenanceLock(path.join(base, '.search-docs-maintenance'));
    const remove = vi.fn(async () => { await expect(lock.acquireShared()).rejects.toThrow(/保守操作/); throw new Error('remove failed'); });
    const options = { projectRoot: root, indexPath: '.search-docs/index', documentsPath: '.search-docs/documents', confirmed: true, prepare: async () => {}, remove };
    await expect(runPurgeTransaction(options)).rejects.toThrow('remove failed');
    await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
    await expect(runPurgeTransaction(options)).rejects.toThrow(/未完了/);
    expect(remove).toHaveBeenCalledOnce();
  });
});
