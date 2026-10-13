import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForServerStart } from '../process.js';

function makeChildProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  }) as ChildProcess;
}

function stubPendingHealthRequest() {
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener(
        'abort',
        () => reject(new Error('Health request aborted')),
        { once: true },
      );
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    isRequestAborted: () => requestSignal?.aborted ?? false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('waitForServerStart child process monitoring', () => {
  it('fails immediately on child exit and aborts the health request', async () => {
    const child = makeChildProcess();
    const health = stubPendingHealthRequest();
    const waiting = waitForServerStart('127.0.0.1', 34567, 660_000, child);

    await vi.waitFor(() => expect(health.fetchMock).toHaveBeenCalledOnce());
    child.emit('exit', 1, null);

    await expect(waiting).rejects.toThrow(
      'Server process exited before becoming healthy (exit code 1)',
    );
    expect(health.isRequestAborted()).toBe(true);
  });

  it('fails immediately on spawn error and aborts the health request', async () => {
    const child = makeChildProcess();
    const health = stubPendingHealthRequest();
    const waiting = waitForServerStart('127.0.0.1', 34567, 660_000, child);

    await vi.waitFor(() => expect(health.fetchMock).toHaveBeenCalledOnce());
    child.emit('error', new Error('spawn failed'));

    await expect(waiting).rejects.toThrow(
      'Server process failed before becoming healthy: spawn failed',
    );
    expect(health.isRequestAborted()).toBe(true);
  });

  it('detects a child that exited before monitoring began', async () => {
    const child = makeChildProcess();
    Object.defineProperty(child, 'exitCode', { value: 1 });
    const health = stubPendingHealthRequest();

    await expect(
      waitForServerStart('127.0.0.1', 34567, 660_000, child),
    ).rejects.toThrow('Server process exited before becoming healthy (exit code 1)');
    expect(health.fetchMock).not.toHaveBeenCalled();
  });
});
