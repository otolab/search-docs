import { describe, expect, it, vi } from 'vitest';
import type { ServiceInstances, SystemStateInfo } from '../../state.js';
import type { ToolRegistrationContext } from '../types.js';

vi.mock('@search-docs/cli/commands/config/init', () => ({ initConfig: vi.fn().mockResolvedValue('overwritten') }));
vi.mock('../../state.js', () => ({
  stopService: vi.fn(async (instances: ServiceInstances) => { await instances.watcherProcess.stop(); }),
  detectSystemState: vi.fn(async () => ({ state: 'RUNNING', projectRoot: '/tmp', config: {} })),
  createService: vi.fn(),
}));

import { createService } from '../../state.js';
import { refreshServiceState } from '../../refresh-service-state.js';
import { registerInitTool } from '../init.js';

describe('MCP init refresh recovery', () => {
  it.each(['unlink failed', 'writer release failed'])('reports %s and uses a new instance for the next refresh', async (message) => {
    const oldStop = vi.fn().mockRejectedValue(new Error(message));
    const newStop = vi.fn().mockResolvedValue(undefined);
    const old = { watcherProcess: { stop: oldStop }, service: {} } as unknown as ServiceInstances;
    const replacement = { watcherProcess: { stop: newStop }, service: {} } as unknown as ServiceInstances;
    vi.mocked(createService).mockResolvedValue(replacement);
    let current: ServiceInstances | null = old;
    const systemState = { state: 'RUNNING', projectRoot: '/tmp', config: {}, service: old.service } as unknown as SystemStateInfo;
    let handler: (args: { force: boolean }) => Promise<unknown> = async () => {};
    const server = { registerTool: (_name: string, _schema: unknown, callback: typeof handler) => { handler = callback; return {}; } };
    const refreshSystemState = () => refreshServiceState({
      cwd: '/tmp', version: 'test', systemState,
      getInstances: () => current,
      setInstances: (value) => { current = value; },
      onRefreshed: () => {}, debugLog: () => {},
    });
    registerInitTool({ server, systemState, refreshSystemState, serverManager: {} } as unknown as ToolRegistrationContext);
    await expect(handler({ force: true })).rejects.toThrow(message);
    expect(current).toBe(replacement);
    expect(systemState.service).toBe(replacement.service);
    await expect(handler({ force: true })).resolves.toBeDefined();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(newStop).toHaveBeenCalledOnce();
  });
});
