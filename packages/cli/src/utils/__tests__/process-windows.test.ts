import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async () => ({
  ...await vi.importActual<typeof import('child_process')>('child_process'),
  spawn: mocks.spawn,
}));
import { killProcessTree } from '../process.js';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
  vi.useRealTimers();
  mocks.spawn.mockReset();
});

describe('Windows process tree cleanup', () => {
  it('waits for forced taskkill and reports its failure even if the first taskkill closes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    const first = new EventEmitter();
    const forced = new EventEmitter();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(forced);
    const pending = killProcessTree(1234, 10);
    const result = expect(pending).rejects.toThrow('taskkill /F failed with code 1');
    await vi.advanceTimersByTimeAsync(10);
    first.emit('close', 0);
    forced.emit('close', 1);
    await result;
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('reports taskkill failure when the target is already missing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const pending = killProcessTree(1234, 100);
    const result = expect(pending).rejects.toThrow('taskkill failed with code 128');
    child.emit('close', 128);
    await result;
  });

  it('reports a root PID that remains alive after taskkill succeeds', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const pending = killProcessTree(1234, 100);
    const result = expect(pending).rejects.toThrow('Process 1234 did not exit after taskkill');
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(1200);
    await result;
  });

  it('accepts taskkill success only after the root PID exits', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    const pending = killProcessTree(1234, 100);
    child.emit('close', 0);
    await expect(pending).resolves.toBeUndefined();
  });
});
