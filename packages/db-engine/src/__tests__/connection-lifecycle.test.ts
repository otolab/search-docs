import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: vi.fn() }, kill: vi.fn(),
  })),
}));
vi.mock('../typescript/process-tree.js', () => ({ stopProcessTree: vi.fn(async () => {}) }));

import { DBEngine } from '../typescript/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('DBEngine connection lifecycle', () => {
  let engine: DBEngine;
  beforeEach(() => {
    vi.stubEnv('IS_DOCKER', 'true');
    engine = new DBEngine();
    vi.spyOn(engine, 'ping').mockResolvedValue({ status: 'ok' });
  });
  afterEach(async () => { await engine.disconnect(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('waits for model initialization for concurrent calls and reconnects after disconnect', async () => {
    const init = deferred<{ success: boolean; model_name: string; dimension: number }>();
    const initialize = vi.spyOn(engine, 'initModel').mockReturnValueOnce(init.promise)
      .mockResolvedValue({ success: true, model_name: 'test', dimension: 3 });
    const first = engine.connect();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    let secondDone = false;
    const second = engine.connect().then(() => { secondDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondDone).toBe(false);
    expect(engine.getConnectionState().state).toBe('initializing_model');
    await expect(engine.getStats()).rejects.toThrow('Not connected');
    init.resolve({ success: true, model_name: 'test', dimension: 3 });
    await Promise.all([first, second, engine.waitForConnection()]);
    expect(engine.getConnectionState().state).toBe('ready');
    await engine.disconnect();
    await engine.connect();
    await engine.waitForConnection();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(engine.getConnectionState().state).toBe('ready');
  });

  it('rejects all concurrent callers if initialization fails', async () => {
    const init = deferred<{ success: boolean; model_name: string; dimension: number }>();
    const initialize = vi.spyOn(engine, 'initModel').mockReturnValue(init.promise);
    const first = engine.connect();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const second = engine.connect();
    const waiting = engine.waitForConnection();
    const outcomes = Promise.allSettled([first, second, waiting]);
    init.reject(new Error('model mismatch'));
    expect((await outcomes).map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(engine.getConnectionState().state).toBe('error');
    await expect(engine.getStats()).rejects.toThrow('Not connected');
    await engine.disconnect();
    initialize.mockResolvedValue({ success: true, model_name: 'test', dimension: 3 });
    await engine.connect();
    await expect(engine.waitForConnection()).resolves.toBeUndefined();
    expect(engine.getConnectionState().state).toBe('ready');
  });
});
