import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileStorage } from '@search-docs/storage';
import { DBEngine, strictMaintenanceLock } from '@search-docs/db-engine';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { createService, stopService, type ServiceInstances } from '../../state.js';
import { registerMaintenanceRepairTool } from '../../tools/maintenance-repair.js';
import type { ToolRegistrationContext } from '../../tools/types.js';

async function snapshot(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(`${path.relative(root, file)}:${createHash('sha256').update(await readFile(file)).digest('hex')}`);
      else throw new Error(`unexpected entry: ${file}`);
    }
  }
  await walk(root);
  return result.sort();
}

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
    let second: ServiceInstances | undefined;
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
      const lock = await strictMaintenanceLock({ projectRoot: root, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath, files: config.files });
      const releaseAdmission = await lock.acquireAdmission();
      let secondStarted = false;
      const starting = createService(config, root, 'test').then(value => { secondStarted = true; return value; });
      try {
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(secondStarted).toBe(false);
      } finally { await releaseAdmission(); }
      second = await starting;
      await vi.waitFor(() => expect(second!.watcherProcess.getStatus().writerState).toBe('sleeping'), { timeout: 15000, interval: 200 });
      let repairHandler!: () => Promise<unknown>;
      const server = { registerTool: vi.fn((_name, _options, handler) => { repairHandler = handler; return {}; }) };
      registerMaintenanceRepairTool({
        server,
        systemState: { state: 'RUNNING', config, projectRoot: root },
        getDbEngine: () => second!.dbEngine,
      } as unknown as ToolRegistrationContext);
      const releaseRepairGate = await lock.acquireAdmission();
      let repairFinished = false;
      const repair = repairHandler().then(value => { repairFinished = true; return value; });
      try {
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(repairFinished).toBe(false);
      } finally { await releaseRepairGate(); }
      await expect(repair).resolves.toBeDefined();
      await stopService(instances);
      instances = undefined;
      await vi.waitFor(() => expect(second!.watcherProcess.getStatus().writerState).toBe('watching'), { timeout: 75000, interval: 250 });
      await writeFile(path.join(root, 'docs/promoted.md'), '# Promoted\n\nafter takeover');
      await copied('docs/promoted.md', 'after takeover');
      await stopService(second);
      second = undefined;
      const indexPath = path.join(root, '.search-docs/index');
      const documentsPath = path.join(root, '.search-docs/documents');
      const beforeLink = [await snapshot(indexPath), await snapshot(documentsPath)];
      await symlink(path.join(root, 'docs/offline.md'), path.join(root, 'docs/link.md'));
      await expect(createService(config, root, 'test')).rejects.toThrow(/シンボリックリンク/);
      expect([await snapshot(indexPath), await snapshot(documentsPath)]).toEqual(beforeLink);
      await rm(path.join(root, 'docs/link.md'));
      const inject = new DBEngine({ dbPath: indexPath });
      try {
        await inject.connect({ skipInitModel: true });
        await inject.createIndexRequest({ documentPath: '../outside.md', documentHash: 'test' });
      } finally {
        await inject.disconnect();
      }
      const beforeUnsafe = [await snapshot(indexPath), await snapshot(documentsPath)];
      await expect(createService(config, root, 'test')).rejects.toThrow();
      expect([await snapshot(indexPath), await snapshot(documentsPath)]).toEqual(beforeUnsafe);
      const clean = new DBEngine({ dbPath: indexPath });
      try {
        await clean.connect({ skipInitModel: true });
        await clean.updateManyIndexRequests({ documentPath: '../outside.md', status: 'pending' }, { status: 'skipped' });
      } finally {
        await clean.disconnect();
      }
      let stoppedRepair!: () => Promise<unknown>;
      const repairServer = { registerTool: vi.fn((_name, _options, handler) => { stoppedRepair = handler; return {}; }) };
      registerMaintenanceRepairTool({
        server: repairServer,
        systemState: { state: 'RUNNING', config, projectRoot: root },
      } as unknown as ToolRegistrationContext);
      const heartbeatPath = path.join(indexPath, 'writer_heartbeat.lance');
      for (const damaged of [path.join(heartbeatPath, '_versions'), heartbeatPath]) {
        await rm(damaged, { recursive: true });
        const before = [await snapshot(indexPath), await snapshot(documentsPath)];
        await expect(createService(config, root, 'test')).rejects.toThrow();
        await expect(stoppedRepair()).rejects.toThrow(/修復前の診断/);
        expect([await snapshot(indexPath), await snapshot(documentsPath)]).toEqual(before);
      }
    } finally {
      try {
        if (instances) await stopService(instances);
        if (second) await stopService(second);
      } finally {
        if (previousEmbeddingUrl === undefined) delete process.env.EMBEDDING_URL;
        else process.env.EMBEDDING_URL = previousEmbeddingUrl;
        await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 180000);
});
