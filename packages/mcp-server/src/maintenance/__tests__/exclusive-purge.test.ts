import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { exclusivePurge } from '../exclusive-purge.js';
import { RequestGate } from '../request-gate.js';
import { ServiceLifecycle } from '../../service-lifecycle.js';
import type { ServiceInstances } from '../../state.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'exclusive-purge-'));
  roots.push(root);
  const layout = { indexPath: path.join(root, 'index'), documentsPath: path.join(root, 'documents'), managementPath: path.join(root, 'control') };
  await mkdir(layout.indexPath);
  await writeFile(path.join(layout.indexPath, 'data'), 'keep');
  const lock = new MaintenanceLock(layout.managementPath);
  const validate = vi.fn(async () => layout);
  const remove = vi.fn(async () => { await rm(layout.indexPath, { recursive: true }); });
  return { layout, lock, validate, remove };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('未公開の purge 排他', () => {
  it('共有利用と確認不足は削除前に拒否し、解放後に削除する', async () => {
    const { layout, lock, validate, remove } = await fixture();
    await expect(exclusivePurge({ confirmed: false, validate, remove })).rejects.toThrow(/確認/);
    const release = await lock.acquireShared();
    await expect(exclusivePurge({ confirmed: true, validate, remove })).rejects.toThrow(/使用中/);
    expect(await readFile(path.join(layout.indexPath, 'data'), 'utf8')).toBe('keep');
    await release();
    await exclusivePurge({ confirmed: true, validate, remove });
    const after = await lock.acquireShared();
    await after();
  });
  it('削除途中の失敗は未完了として残し、purge が勝手に解除しない', async () => {
    const { lock, validate, remove } = await fixture();
    remove.mockRejectedValueOnce(new Error('remove failed'));
    await expect(exclusivePurge({ confirmed: true, validate, remove })).rejects.toThrow('remove failed');
    await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
    await expect(exclusivePurge({ confirmed: true, validate, remove })).rejects.toThrow(/未完了/);
    expect(remove).toHaveBeenCalledOnce();
  });
  it('子プロセスの停止を確認できなければ排他も未完了マーカーも保持する', async () => {
    const { layout, lock, validate, remove } = await fixture();
    remove.mockRejectedValueOnce(new UnconfirmedProcessStopError(new Error('stop failed')));
    await expect(exclusivePurge({ confirmed: true, validate, remove })).rejects.toThrow(/停止を確認/);
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    await expect(lock.acquireExclusive()).rejects.toThrow(/保守操作/);
    expect((await lstat(path.join(layout.managementPath, 'incomplete'))).isDirectory()).toBe(true);
  });
  it('排他取得後に配置が変化したら削除しない', async () => {
    const { layout, validate, remove } = await fixture();
    validate.mockResolvedValueOnce(layout).mockResolvedValueOnce({ ...layout, indexPath: '/other/index' });
    await expect(exclusivePurge({ confirmed: true, validate, remove })).rejects.toThrow(/変更/);
    expect(remove).not.toHaveBeenCalled();
  });
  it('受理済み要求とサービス停止後に排他削除し、共有登録を再取得して再開する', async () => {
    const { lock, validate, remove } = await fixture();
    const gate = new RequestGate();
    let finish!: () => void;
    const pending = gate.run(() => new Promise<void>(resolve => { finish = resolve; }));
    const shared = await lock.acquireShared();
    let restartedRelease: (() => Promise<void>) | undefined;
    let current: ServiceInstances | null = {
      watcherProcess: { stop: vi.fn(async () => {}) },
      service: { stop: vi.fn(async () => {}) },
      dbEngine: { disconnect: vi.fn(async () => {}) },
      embeddingServer: { shutdown: vi.fn() },
      releaseStorageRegistration: shared,
    } as unknown as ServiceInstances;
    const lifecycle = new ServiceLifecycle(async () => { restartedRelease = await lock.acquireShared(); }, () => current, value => { current = value; });
    const running = lifecycle.maintenance(gate, () => {}, () => exclusivePurge({ confirmed: true, validate, remove }));
    await vi.waitFor(() => expect(gate.run(async () => {})).rejects.toThrow(/保守中/));
    expect(remove).not.toHaveBeenCalled();
    finish();
    await pending;
    await running;
    expect(remove).toHaveBeenCalledOnce();
    expect(restartedRelease).toBeDefined();
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    await restartedRelease!();
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});
