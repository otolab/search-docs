import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolRegistrationContext } from '../types.js';
const mocks = vi.hoisted(() => ({ diagnose: vi.fn(), acquire: vi.fn(), admission: vi.fn(), release: vi.fn(), releaseAdmission: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), repair: vi.fn() }));
vi.mock('@search-docs/server', () => ({ diagnoseStrictConfig: mocks.diagnose }));
vi.mock('@search-docs/db-engine', () => ({
  UnconfirmedProcessStopError: class extends Error {},
  strictMaintenanceLock: vi.fn(async () => ({ acquireShared: mocks.acquire, acquireAdmission: mocks.admission })),
  DBEngine: class { connect = mocks.connect; disconnect = mocks.disconnect; repairTables = mocks.repair; },
}));
import { registerMaintenanceRepairTool } from '../maintenance-repair.js';
afterEach(() => { vi.clearAllMocks(); });
function setup(existing: boolean) {
  let handler: (() => Promise<unknown>) | undefined;
  const config = { storage: { indexPath: 'index', documentsPath: 'documents' } };
  const server = { registerTool: (_name: unknown, _definition: unknown, fn: () => Promise<unknown>) => { handler = fn; return {}; } };
  mocks.acquire.mockResolvedValue(mocks.release); mocks.admission.mockResolvedValue(mocks.releaseAdmission);
  mocks.diagnose.mockResolvedValue(undefined); mocks.connect.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined);
  mocks.repair.mockResolvedValue({ tables: {}, repairedCount: 0 });
  const engine = { repairTables: mocks.repair };
  registerMaintenanceRepairTool({ server, systemState: { state: 'RUNNING', config, projectRoot: '/project' }, getDbEngine: () => existing ? engine : null } as unknown as ToolRegistrationContext);
  return handler!;
}
describe('MCP repair 診断', () => {
  it.each([true, false])('診断失敗時は既存 DB / fallback を変更しない: existing=%s', async existing => {
    const run = setup(existing); mocks.diagnose.mockRejectedValue(new Error('unreadable'));
    await expect(run()).rejects.toThrow(/CLI/);
    expect(mocks.repair).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.releaseAdmission).toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalled();
  });
  it.each([true, false])('診断成功後に repair を実行する: existing=%s', async existing => {
    const run = setup(existing); await run();
    expect(mocks.diagnose.mock.invocationCallOrder[0]).toBeLessThan(mocks.repair.mock.invocationCallOrder[0]);
  });
});
