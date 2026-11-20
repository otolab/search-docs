import { describe, expect, it, vi, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), acquire: vi.fn(), connect: vi.fn(), repair: vi.fn(), disconnect: vi.fn(), release: vi.fn() }));
vi.mock('@search-docs/config', () => ({ ConfigLoader: { resolve: mocks.resolve } }));
vi.mock('@search-docs/db-engine', () => ({
  acquireStandardStorageRegistration: mocks.acquire,
  DBEngine: class { connect = mocks.connect; repairTables = mocks.repair; disconnect = mocks.disconnect; },
}));
import { executeMaintenanceRepair } from '../maintenance/repair.js';
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
function setup() {
  mocks.resolve.mockResolvedValue({ projectRoot: '/project', config: { storage: { indexPath: '.search-docs/index', documentsPath: '.search-docs/documents' } } });
  mocks.acquire.mockResolvedValue(mocks.release);
  mocks.connect.mockResolvedValue(undefined);
  mocks.repair.mockResolvedValue({ tables: {}, repairedCount: 0 });
  mocks.release.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
}
describe('repair の共有登録', () => {
  it('DB の停止後に登録を解放する', async () => {
    setup();
    mocks.disconnect.mockResolvedValue(undefined);
    await executeMaintenanceRepair({});
    expect(mocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(mocks.release.mock.invocationCallOrder[0]);
  });
  it('停止失敗時は登録を解放しない', async () => {
    setup();
    mocks.disconnect.mockRejectedValue(new Error('stop failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(executeMaintenanceRepair({})).rejects.toThrow('exit');
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
