import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strictMaintenanceLock } from '@search-docs/db-engine';
import { DEFAULT_CONFIG } from '@search-docs/types';

describe.skipIf(process.platform === 'win32')('MCP 並列起動', () => {
  it('新規プロジェクトで5プロセスが30秒以内に接続し、起動中 SIGKILL 後も再起動できる', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-parallel-startup-'));
    const healthRequests: Array<() => void> = [];
    const delayedHealth = createServer((req, res) => {
      if (req.url === '/health') {
        healthRequests.shift()?.();
        return;
      }
      res.writeHead(404).end();
    });
    const embedding = createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ready') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          status: 'ok', ready: true, model: 'test', vectorDimension: 256,
        }));
        return;
      }
      req.resume();
      req.on('end', () => res.writeHead(404).end());
    });
    const listen = async (server: typeof embedding): Promise<string> => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listen failed');
      return `http://127.0.0.1:${address.port}`;
    };
    const embeddingUrl = await listen(embedding);
    const blockedEmbeddingUrl = await listen(delayedHealth);
    const config = {
      ...DEFAULT_CONFIG,
      project: { name: 'parallel-startup-test', root },
      files: { ...DEFAULT_CONFIG.files, sources: [], respectGitignore: false },
      indexing: { ...DEFAULT_CONFIG.indexing, embeddingUrl },
      worker: { ...DEFAULT_CONFIG.worker, enabled: false },
      watcher: { ...DEFAULT_CONFIG.watcher, enabled: false },
    };
    await writeFile(path.join(root, '.search-docs.json'), JSON.stringify(config));

    const clients: Client[] = [];
    const transportOptions = {
      command: process.execPath,
      args: [path.resolve('dist/server.js'), '--project-dir', root],
      cwd: root,
      stderr: 'pipe' as const,
      env: {
        ...(process.env as Record<string, string>),
        EMBEDDING_URL: embeddingUrl,
        UV_NO_SYNC: '1',
        UV_CACHE_DIR: '/tmp/search-docs-uv-cache',
      },
    };
    let killedStartup: ReturnType<typeof spawn> | undefined;
    try {
      const startedAt = Date.now();
      await Promise.race([
        Promise.all(Array.from({ length: 5 }, async () => {
          const client = new Client({ name: 'parallel-startup-test', version: '1' });
          clients.push(client);
          await client.connect(new StdioClientTransport(transportOptions));
        })),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('5 MCP processes did not connect within 30 seconds')), 30000).unref();
        }),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(30000);

      const lock = await strictMaintenanceLock({
        projectRoot: root,
        indexPath: config.storage.indexPath,
        documentsPath: config.storage.documentsPath,
        files: config.files,
      });
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);

      const healthRequested = new Promise<void>(resolve => healthRequests.push(resolve));
      killedStartup = spawn(process.execPath, [path.resolve('dist/server.js'), '--project-dir', root], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...transportOptions.env, EMBEDDING_URL: blockedEmbeddingUrl },
      });
      await Promise.race([
        healthRequested,
        once(killedStartup, 'exit').then(() => { throw new Error('startup process exited before its embedding probe'); }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('startup process did not reach its embedding probe')), 15000).unref();
        }),
      ]);
      const startupExit = once(killedStartup, 'exit');
      killedStartup.kill('SIGKILL');
      await startupExit;

      const restarted = new Client({ name: 'after-sigkill', version: '1' });
      clients.push(restarted);
      await restarted.connect(new StdioClientTransport(transportOptions));
    } finally {
      if (killedStartup && killedStartup.exitCode === null && killedStartup.signalCode === null) {
        const startupExit = once(killedStartup, 'exit');
        killedStartup.kill('SIGKILL');
        await startupExit;
      }
      await Promise.allSettled(clients.map(client => client.close()));
      await Promise.all([
        new Promise<void>((resolve, reject) => embedding.close(error => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => delayedHealth.close(error => error ? reject(error) : resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});
