import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ config: undefined as unknown, layout: undefined as unknown, mark: vi.fn(), complete: vi.fn(), release: vi.fn(), diagnose: vi.fn(), recreate: vi.fn(), probe: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('@search-docs/config', () => ({ ConfigLoader: { resolve: vi.fn(async () => mocks.config) } }));
vi.mock('@search-docs/server', () => ({ assertPurgeSourcesOutsideIndex: vi.fn(), diagnoseStrictConfig: mocks.diagnose }));
vi.mock('@search-docs/db-engine', () => ({
  UnconfirmedProcessStopError: class extends Error {},
  strictMaintenanceLock: vi.fn(async () => ({ acquireExclusive: async () => ({ markIncomplete: mocks.mark, complete: mocks.complete, release: mocks.release }) })),
  DBEngine: class { connect = mocks.connect; disconnect = mocks.disconnect; probeRepairTable = mocks.probe; recreateRepairTable = mocks.recreate; checkRepairDimension = vi.fn(); },
}));
vi.mock('../../utils/rebuild-layout.js', () => ({ validateRebuildLayout: vi.fn(async () => mocks.layout) }));
import { executeForceRepair } from '../maintenance/force-repair.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'force-repair-test-')); roots.push(root);
  const indexPath = path.join(root, 'data', 'index');
  const documentsPath = path.join(root, 'data', 'documents');
  await mkdir(path.join(indexPath, 'sections.lance'), { recursive: true });
  await mkdir(documentsPath);
  mocks.layout = { indexPath, documentsPath, managementPath: path.join(root, 'data', '.search-docs-maintenance') };
  mocks.config = { projectRoot: root, config: { project: { root }, storage: { indexPath, documentsPath }, indexing: { vectorDimension: 4 }, files: { sources: ['**/*.md'], exclude: [] } } };
  mocks.probe.mockImplementation(async (name: string) => name === 'sections' ? { readable: false, error: 'read failure' } : { readable: true });
  mocks.connect.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined);
  mocks.mark.mockResolvedValue(undefined); mocks.complete.mockResolvedValue(undefined); mocks.release.mockResolvedValue(undefined);
  mocks.diagnose.mockResolvedValue(undefined); mocks.recreate.mockResolvedValue(undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await executeForceRepair({ table: 'sections' });
  const preview = String(log.mock.calls[0][0]);
  const token = preview.match(/--confirm ([a-f0-9]{64})/)?.[1];
  expect(token).toBeDefined();
  return token!;
}

describe('強制修復の二段階確認', () => {
  it('プレビューでは変更せず、確認後に未完了マーカー・対象変更・通常診断の順で実行する', async () => {
    const token = await fixture();
    expect(mocks.recreate).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
    await executeForceRepair({ table: 'sections', confirm: token, backup: true, isolated: true });
    expect(mocks.mark.mock.invocationCallOrder[0]).toBeLessThan(mocks.recreate.mock.invocationCallOrder[0]);
    expect(mocks.recreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(mocks.diagnose).toHaveBeenLastCalledWith(expect.any(Object));
    expect(mocks.diagnose.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
  });
  it('明示確認が足りない、または対象変更後の失敗では完了しない', async () => {
    const token = await fixture();
    await expect(executeForceRepair({ table: 'sections', confirm: token })).rejects.toThrow(/確認/);
    mocks.recreate.mockRejectedValue(new Error('injected'));
    await expect(executeForceRepair({ table: 'sections', confirm: token, backup: true, isolated: true })).rejects.toThrow('injected');
    expect(mocks.mark).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
    // プレビューの解放のみ。破壊処理開始後の失敗では排他を保持する。
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it('再作成後の通常診断が失敗したら未完了のまま排他を保持する', async () => {
    const token = await fixture();
    mocks.diagnose.mockImplementation(async (_config, options) => {
      if (!options) throw new Error('post-diagnostic failed');
    });
    await expect(executeForceRepair({ table: 'sections', confirm: token, backup: true, isolated: true })).rejects.toThrow('post-diagnostic failed');
    expect(mocks.recreate).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
