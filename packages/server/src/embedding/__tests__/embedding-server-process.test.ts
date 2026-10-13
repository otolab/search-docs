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

    expect(waitForReady).toHaveBeenCalledWith('http://localhost:24281', 42_000);
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

    expect(waitForReady).toHaveBeenCalledWith('http://localhost:24282', 39_000);
  });
});
