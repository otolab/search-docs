import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingServerProcess } from '../embedding-server-process.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('EmbeddingServerProcess readiness timeout', () => {
  it('uses the configured timeout when starting a local embedding server', async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    const server = new EmbeddingServerProcess({ port: 24281, readyTimeoutMs: 42_000 });
    const privateMethods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      resolveScriptPath: (isDocker: boolean) => string;
      waitForReady: (url: string, timeoutMs: number) => Promise<void>;
    };
    vi.spyOn(privateMethods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(privateMethods, 'resolveScriptPath').mockReturnValue('/fake/embedding_server.py');
    const waitForReady = vi.spyOn(privateMethods, 'waitForReady').mockResolvedValue();

    await server.start();

    expect(waitForReady).toHaveBeenCalledWith(
      'http://localhost:24281',
      42_000,
      expect.any(EventEmitter),
    );
  });

  it('reads the shared timeout environment variable when no option is supplied', async () => {
    vi.stubEnv('SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS', '39000');
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    const server = new EmbeddingServerProcess({ port: 24282 });
    const privateMethods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      resolveScriptPath: (isDocker: boolean) => string;
      waitForReady: (url: string, timeoutMs: number) => Promise<void>;
    };
    vi.spyOn(privateMethods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(privateMethods, 'resolveScriptPath').mockReturnValue('/fake/embedding_server.py');
    const waitForReady = vi.spyOn(privateMethods, 'waitForReady').mockResolvedValue();

    await server.start();

    expect(waitForReady).toHaveBeenCalledWith(
      'http://localhost:24282',
      39_000,
      expect.any(EventEmitter),
    );
  });

  it.skipIf(process.platform === 'win32')('stops and reaps the local process tree after readiness times out', async () => {
    let groupAlive = true;
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stderr: new EventEmitter(),
    });
    spawnMock.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -43210 && signal === 'SIGTERM') {
        groupAlive = false;
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
        return true;
      }
      if (pid === -43210 && signal === 0) {
        if (groupAlive) return true;
        throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    const server = new EmbeddingServerProcess({ port: 24283 });
    const privateMethods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      resolveScriptPath: (isDocker: boolean) => string;
      waitForReady: (url: string, timeoutMs: number, process: EventEmitter) => Promise<void>;
    };
    vi.spyOn(privateMethods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(privateMethods, 'resolveScriptPath').mockReturnValue('/fake/embedding_server.py');
    vi.spyOn(privateMethods, 'waitForReady').mockRejectedValue(
      new Error('did not become ready within 10ms'),
    );

    await expect(server.start()).rejects.toThrow('did not become ready within 10ms');

    expect(kill).toHaveBeenCalledWith(-43210, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-43210, 0);
    expect(groupAlive).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('detects signal termination immediately and reaps remaining group members', async () => {
    let groupAlive = true;
    const child = Object.assign(new EventEmitter(), {
      pid: 43211,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stderr: new EventEmitter(),
    });
    spawnMock.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -43211 && signal === 'SIGTERM') {
        groupAlive = false;
        child.signalCode = 'SIGTERM';
        return true;
      }
      if (pid === -43211 && signal === 0) {
        if (groupAlive) return true;
        throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    const server = new EmbeddingServerProcess({ port: 24284, readyTimeoutMs: 60_000 });
    const privateMethods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      resolveScriptPath: (isDocker: boolean) => string;
      readinessCheck: (url: string) => Promise<boolean>;
    };
    vi.spyOn(privateMethods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(privateMethods, 'resolveScriptPath').mockReturnValue('/fake/embedding_server.py');
    vi.spyOn(privateMethods, 'readinessCheck').mockImplementation(async () => {
      child.signalCode = 'SIGTERM';
      return false;
    });

    await expect(server.start()).rejects.toThrow('Process exited with signal SIGTERM');

    expect(kill).toHaveBeenCalledWith(-43211, 'SIGTERM');
    expect(groupAlive).toBe(false);
  });

  it('reports spawn errors instead of waiting for the readiness timeout', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
    });
    spawnMock.mockReturnValue(child);
    const server = new EmbeddingServerProcess({ port: 24285, readyTimeoutMs: 60_000 });
    const privateMethods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      resolveScriptPath: (isDocker: boolean) => string;
      readinessCheck: (url: string) => Promise<boolean>;
    };
    vi.spyOn(privateMethods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(privateMethods, 'resolveScriptPath').mockReturnValue('/fake/embedding_server.py');
    vi.spyOn(privateMethods, 'readinessCheck').mockImplementation(async () => {
      child.emit('error', new Error('spawn ENOENT'));
      return false;
    });

    await expect(server.start()).rejects.toThrow('Failed to start local process: spawn ENOENT');
  });
});
