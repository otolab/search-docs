import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';
import { runRebuildTransaction } from '../rebuild-transaction.js';

const temporary: string[] = [];
async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'rebuild-transaction-'));
  temporary.push(projectRoot);
  await mkdir(path.join(projectRoot, '.search-docs'));
  const lock = new MaintenanceLock(path.join(projectRoot, '.search-docs', '.search-docs-maintenance'));
  const options = {
    projectRoot, indexPath: '.search-docs/index', documentsPath: '.search-docs/documents', confirmed: true,
    prepare: vi.fn(async () => 'snapshot'), clear: vi.fn(async () => {}), rebuild: vi.fn(async (_snapshot: string) => {}),
  };
  return { lock, options };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('runRebuildTransaction', () => {
  it('確認・配置・事前検査が失敗したら削除しない', async () => {
    const { options } = await fixture();
    await expect(runRebuildTransaction({ ...options, confirmed: false })).rejects.toThrow(/確認/);
    await expect(runRebuildTransaction({ ...options, indexPath: 'other' })).rejects.toThrow(/標準/);
    await expect(runRebuildTransaction({ ...options, prepare: async () => { throw new Error('invalid sources'); } })).rejects.toThrow('invalid sources');
    expect(options.clear).not.toHaveBeenCalled();
  });
  it('利用中なら削除せず、解放後は再構築完了まで排他する', async () => {
    const { lock, options } = await fixture();
    const release = await lock.acquireShared();
    await expect(runRebuildTransaction(options)).rejects.toThrow(/使用中/);
    expect(options.clear).not.toHaveBeenCalled();
    await release();
    options.rebuild.mockImplementation(async snapshot => {
      expect(snapshot).toBe('snapshot');
      await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    });
    await runRebuildTransaction(options);
    const after = await lock.acquireShared();
    await after();
  });
  it('再構築に失敗すると未完了のまま通常利用を拒否し、再試行で復旧する', async () => {
    const { lock, options } = await fixture();
    options.rebuild.mockRejectedValueOnce(new Error('indexing failed'));
    await expect(runRebuildTransaction(options)).rejects.toThrow('indexing failed');
    await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
    await runRebuildTransaction(options);
    const after = await lock.acquireShared();
    await after();
  });
  it('子プロセスの停止を確認できなければ排他を保持し、再試行も拒否する', async () => {
    const { lock, options } = await fixture();
    options.rebuild.mockRejectedValueOnce(new UnconfirmedProcessStopError(new Error('stop failed')));
    await expect(runRebuildTransaction(options)).rejects.toThrow(/停止を確認できません/);
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    await expect(runRebuildTransaction(options)).rejects.toThrow(/保守操作/);
  });
});
