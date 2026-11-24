import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileStorage } from '@search-docs/storage';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { createService, stopService, type ServiceInstances } from '../../state.js';

describe.skipIf(process.platform === 'win32')('strict サービスと native watcher', () => {
  it('探索、監視、停止中の変更を同じキーで保存し、再起動時に照合する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'strict-service-'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, '.gitignore'), 'docs/ignored.md\n');
    await writeFile(path.join(root, 'docs/first.md'), '# First\n\ninitial');
    await writeFile(path.join(root, 'docs/excluded.md'), '# Excluded');
    await writeFile(path.join(root, 'docs/ignored.md'), '# Ignored');
    const http = createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ready') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', ready: true, model: 'test', vectorDimension: 256 }));
        return;
      }
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; dimensions: number };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          embeddings: body.input.map(() => Array.from({ length: body.dimensions }, (_, i) => i === 0 ? 1 : 0)),
        }));
      });
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    const previousEmbeddingUrl = process.env.EMBEDDING_URL;
    process.env.EMBEDDING_URL = `http://127.0.0.1:${address.port}`;
    const config = {
      ...DEFAULT_CONFIG,
      project: { name: 'strict-test', root },
      files: { ...DEFAULT_CONFIG.files, sources: ['docs/**/*.md'], exclude: ['docs/excluded.md'], respectGitignore: true },
      indexing: { ...DEFAULT_CONFIG.indexing, embeddingUrl: `http://127.0.0.1:${address.port}` },
      worker: { ...DEFAULT_CONFIG.worker, interval: 200 },
      watcher: { ...DEFAULT_CONFIG.watcher, debounceMs: 100, awaitWriteFinishMs: 100 },
    };
    const storage = new FileStorage({ basePath: path.join(root, '.search-docs/documents') });
    let instances: ServiceInstances | undefined;
    const copied = async (name: string, text: string) => {
      await vi.waitFor(async () => expect((await storage.get(name))?.content).toContain(text), { timeout: 30000, interval: 200 });
    };
    const indexed = async (name: string) => {
      await vi.waitFor(async () => expect(await instances!.dbEngine.getIndexedPaths()).toContain(name), { timeout: 30000, interval: 200 });
    };
    try {
      instances = await createService(config, root, 'test');
      await copied('docs/first.md', 'initial');
      await indexed('docs/first.md');
      expect(await storage.get('docs/excluded.md')).toBeNull();
      expect(await storage.get('docs/ignored.md')).toBeNull();
      await writeFile(path.join(root, 'docs/added.md'), '# Added\n\nnew');
      await copied('docs/added.md', 'new');
      await indexed('docs/added.md');
      await writeFile(path.join(root, 'docs/added.md'), '# Added\n\nchanged');
      await copied('docs/added.md', 'changed');
      await rm(path.join(root, 'docs/added.md'));
      await vi.waitFor(async () => expect(await storage.get('docs/added.md')).toBeNull(), { timeout: 30000, interval: 200 });
      await stopService(instances);
      instances = undefined;
      await rm(path.join(root, 'docs/first.md'));
      await writeFile(path.join(root, 'docs/offline.md'), '# Offline\n\ncreated while stopped');
      instances = await createService(config, root, 'test');
      await copied('docs/offline.md', 'created while stopped');
      await indexed('docs/offline.md');
      await vi.waitFor(async () => expect(await storage.get('docs/first.md')).toBeNull(), { timeout: 30000, interval: 200 });
      expect(await instances.dbEngine.getIndexedPaths()).not.toContain('docs/first.md');
    } finally {
      try {
        if (instances) await stopService(instances);
      } finally {
        if (previousEmbeddingUrl === undefined) delete process.env.EMBEDDING_URL;
        else process.env.EMBEDDING_URL = previousEmbeddingUrl;
        await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 120000);
});
