import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceInstances } from '../../state.js';
import type { ToolRegistrationContext } from '../types.js';

vi.mock('@search-docs/cli/commands/config/init', () => ({ initConfig: vi.fn().mockResolvedValue('overwritten') }));
vi.mock('../../state.js', () => ({
  stopService: vi.fn(async (instances: ServiceInstances) => { await instances.watcherProcess.stop(); }),
  detectSystemState: vi.fn(async () => ({ state: 'RUNNING', projectRoot: '/tmp', config: {} })),
  createService: vi.fn(),
}));
import { createService } from '../../state.js';
import { refreshServiceState } from '../../refresh-service-state.js';
import { ServiceLifecycle, registerShutdownHandlers } from '../../service-lifecycle.js';
import { registerInitTool } from '../init.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function instances(stop: () => Promise<void>): ServiceInstances {
  return { watcherProcess: { stop }, service: {} } as unknown as ServiceInstances;
}

describe('MCP lifecycle', () => {
  it.each(['stop', 'create'])('waits for refresh %s and drains the created service on SIGTERM', async (phase) => {
    const blocked = gate();
    const entered = gate();
    const oldStop = vi.fn(async () => { if (phase === 'stop') { entered.release(); await blocked.promise; } });
    const newStop = vi.fn(async () => {});
    const old = instances(oldStop);
    const replacement = instances(newStop);
    vi.mocked(createService).mockImplementation(async () => {
      if (phase === 'create') { entered.release(); await blocked.promise; }
      return replacement;
    });
    let current: ServiceInstances | null = old;
    const state = { state: 'RUNNING', projectRoot: '/tmp', config: {}, service: old.service } as unknown as import('../../state.js').SystemStateInfo;
    const lifecycle = new ServiceLifecycle(() => refreshServiceState({
      cwd: '/tmp', version: 'test', systemState: state,
      getInstances: () => current, setInstances: value => { current = value; }, onRefreshed: () => {}, debugLog: () => {},
    }), () => current, value => { current = value; });
    let handler: (args: { force: boolean }) => Promise<unknown> = async () => {};
    const server = { registerTool: (_name: string, _schema: unknown, callback: typeof handler) => { handler = callback; return {}; } };
    registerInitTool({ server, systemState: state, refreshSystemState: () => lifecycle.refresh(), serverManager: {} } as unknown as ToolRegistrationContext);
    const signals = new EventEmitter();
    const exit = vi.fn();
    const report = vi.fn();
    registerShutdownHandlers(signals as unknown as NodeJS.Process, () => lifecycle.shutdown(), exit, report);
    const refresh = handler({ force: true });
    await entered.promise;
    signals.emit('SIGTERM');
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    blocked.release();
    await refresh;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(oldStop).toHaveBeenCalledOnce();
    expect(newStop).toHaveBeenCalledOnce();
    expect(current).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('serializes concurrent refresh calls and stops each replaced service', async () => {
    const blocked = gate();
    const entered = gate();
    const oldStop = vi.fn(async () => { entered.release(); await blocked.promise; });
    const middleStop = vi.fn(async () => {});
    const finalStop = vi.fn(async () => {});
    let current: ServiceInstances | null = instances(oldStop);
    const middle = instances(middleStop);
    const final = instances(finalStop);
    vi.mocked(createService).mockReset().mockResolvedValueOnce(middle).mockResolvedValueOnce(final);
    const state = { state: 'RUNNING', projectRoot: '/tmp', config: {} } as unknown as import('../../state.js').SystemStateInfo;
    const lifecycle = new ServiceLifecycle(() => refreshServiceState({
      cwd: '/tmp', version: 'test', systemState: state,
      getInstances: () => current, setInstances: value => { current = value; }, onRefreshed: () => {}, debugLog: () => {},
    }), () => current, value => { current = value; });
    const first = lifecycle.refresh();
    await entered.promise;
    const second = lifecycle.refresh();
    expect(createService).not.toHaveBeenCalled();
    blocked.release();
    await Promise.all([first, second]);
    expect(oldStop).toHaveBeenCalledOnce();
    expect(middleStop).toHaveBeenCalledOnce();
    expect(current).toBe(final);
    await lifecycle.shutdown();
    expect(finalStop).toHaveBeenCalledOnce();
  });
  it('continues the queue after a failed refresh and reports shutdown failure', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('stop failure'));
    let current: ServiceInstances | null = instances(stop);
    let calls = 0;
    const lifecycle = new ServiceLifecycle(async () => {
      calls++;
      if (calls === 1) throw new Error('creation failure');
    }, () => current, value => { current = value; });
    await expect(lifecycle.refresh()).rejects.toThrow('creation failure');
    await expect(lifecycle.refresh()).resolves.toBeUndefined();
    await expect(lifecycle.shutdown()).rejects.toThrow('stop failure');
    await expect(lifecycle.refresh()).rejects.toThrow('shutting down');
    expect(stop).toHaveBeenCalledOnce();
  });

});
