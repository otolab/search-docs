import { describe, expect, it, vi } from 'vitest';
import { registerIndexPurgeTool } from '../index-purge.js';
import type { ToolRegistrationContext } from '../types.js';

describe('index_purge', () => {
  it('利用者の確認がなければ保守を開始しない', async () => {
    let handler: ((args: { confirmIsolated: boolean }) => Promise<unknown>) | undefined;
    const server = { registerTool: vi.fn((_name, _config, callback) => { handler = callback; return {}; }) };
    const refreshSystemState = vi.fn();
    const runMaintenance = vi.fn();
    registerIndexPurgeTool({ server, systemState: { state: 'RUNNING', config: {} }, refreshSystemState, runMaintenance } as unknown as ToolRegistrationContext);
    await expect(handler!({ confirmIsolated: false })).rejects.toThrow(/確認してください/);
    expect(refreshSystemState).not.toHaveBeenCalled();
    expect(runMaintenance).not.toHaveBeenCalled();
  });
});
