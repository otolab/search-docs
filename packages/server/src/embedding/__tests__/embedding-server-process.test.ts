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
  it('selects the torch extra for a local torch runtime', async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    const server = new EmbeddingServerProcess({ embedding: { provider: 'builtin', runtime: 'torch' } });
    const privateMethods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      resolveScriptPath: (isDocker: boolean) => string;
      waitForReady: (url: string, timeoutMs: number) => Promise<void>;
    };
    vi.spyOn(privateMethods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(privateMethods, 'resolveScriptPath').mockReturnValue('/fake/embedding_server.py');
    vi.spyOn(privateMethods, 'waitForReady').mockResolvedValue();
    vi.stubEnv('IS_DOCKER', 'false');

    await server.start();

    expect(spawnMock).toHaveBeenCalledWith('uv', expect.arrayContaining(['--extra', 'torch', '--runtime=torch']), expect.any(Object));
  });

  it('continues to prefer an available shared server when torch is requested', async () => {
    const server = new EmbeddingServerProcess({ embedding: { provider: 'builtin', runtime: 'torch' } });
    const methods = server as unknown as { externalServerReady: (url: string) => Promise<boolean> };
    vi.spyOn(methods, 'externalServerReady').mockResolvedValue(true);

    expect(await server.start()).toBe('http://127.0.0.1:24281');
    expect(server.isExternal()).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

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

describe('explicit external embedding server', () => {
  it('reuses a local server when no URL is configured', async () => {
    const server = new EmbeddingServerProcess({});
    const methods = server as unknown as { externalServerReady: (url: string) => Promise<boolean> };
    const check = vi.spyOn(methods, 'externalServerReady').mockResolvedValue(true);
    await expect(server.start()).resolves.toBe('http://127.0.0.1:24281');
    expect(check).toHaveBeenCalledWith('http://127.0.0.1:24281');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no configured URL', undefined],
    ['unavailable legacy configured URL', 'http://127.0.0.1:1'],
  ])('starts the local server with %s', async (_label, embeddingUrl) => {
    const server = new EmbeddingServerProcess({ embeddingUrl });
    const methods = server as unknown as {
      externalServerReady: (url: string) => Promise<boolean>;
      startLocal: (port: number) => Promise<void>;
      url: string;
    };
    vi.spyOn(methods, 'externalServerReady').mockResolvedValue(false);
    vi.spyOn(methods, 'startLocal').mockImplementation(async () => {
      methods.url = 'http://localhost:24281';
    });
    await expect(server.start()).resolves.toBe('http://localhost:24281');
    expect(methods.startLocal).toHaveBeenCalledOnce();
  });

  it('fails without falling back when the configured URL is unavailable', async () => {
    const server = new EmbeddingServerProcess({ embeddingUrl: 'http://127.0.0.1:1', requireEmbeddingUrl: true });
    const methods = server as unknown as { externalServerReady: (url: string) => Promise<boolean> };
    vi.spyOn(methods, 'externalServerReady').mockResolvedValue(false);
    await expect(server.start()).rejects.toThrow('unavailable or not ready');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts an Ollama tags endpoint when health is unavailable', async () => {
    const { createServer } = await import('node:http');
    const httpServer = createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'example:latest' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('No server address');
      const url = `http://127.0.0.1:${address.port}`;
      const server = new EmbeddingServerProcess({ embeddingUrl: url });
      await expect(server.start()).resolves.toBe(url);
      expect(server.isExternal()).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
