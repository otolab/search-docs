import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MaintenanceLock } from '../maintenance-lock.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'maintenance-lock-'));
  roots.push(root);
  return { directory: path.join(root, 'control'), lock: new MaintenanceLock(path.join(root, 'control')) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('MaintenanceLock', () => {
  it('通常利用が同時に開始しても共有登録できる', async () => {
    const { directory } = await fixture();
    const releases = await Promise.all(Array.from({ length: 8 }, () => new MaintenanceLock(directory).acquireShared()));
    const lock = new MaintenanceLock(directory);
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    await Promise.all(releases.map(release => release()));
    const exclusive = await lock.acquireExclusive();
    await exclusive.release();
  });

  it('共有利用中は排他取得できず、解放後は取得できる', async () => {
    const { lock } = await fixture();
    const release1 = await lock.acquireShared();
    const release2 = await lock.acquireShared();
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    await release1();
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    await release2();
    const exclusive = await lock.acquireExclusive();
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    await exclusive.release();
  });

  it('同時の排他取得は一つだけ成功する', async () => {
    const { directory } = await fixture();
    const results = await Promise.allSettled([new MaintenanceLock(directory).acquireExclusive(), new MaintenanceLock(directory).acquireExclusive()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled');
    if (winner?.status === 'fulfilled') await winner.value.release();
  });

  it('失敗後のマーカーは通常利用を拒否し、再試行成功後に解除できる', async () => {
    const { lock } = await fixture();
    const first = await lock.acquireExclusive();
    await first.markIncomplete();
    await first.release();
    await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
    const retry = await lock.acquireExclusive();
    await retry.markIncomplete();
    await retry.complete();
    await retry.release();
    const release = await lock.acquireShared();
    await release();
  });

  it('ゲートが残った場合は自動解除せず拒否する', async () => {
    const { directory, lock } = await fixture();
    await mkdir(path.join(directory, 'gate'), { recursive: true });
    await expect(lock.acquireExclusive()).rejects.toThrow(/残存ロック/);
    await expect(lock.acquireShared()).rejects.toThrow(/残存ロック/);
  });

  it('残った利用登録を自動解除しない', async () => {
    const { lock } = await fixture();
    await lock.acquireShared();
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
  });
});
