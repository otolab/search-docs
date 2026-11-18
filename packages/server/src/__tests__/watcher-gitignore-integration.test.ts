import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsConfig } from '@search-docs/types';
import { WatcherProcess } from '../watcher/watcher-process.js';

function createConfig(): SearchDocsConfig {
  return {
    version: '1.0',
    project: {
      name: 'watcher-process-test',
      root: process.cwd(),
    },
    files: {
      sources: ['**/*.md'],
      exclude: [],
      ignoreGitignore: false,
      maxFileSize: 10 * 1024 * 1024,
    },
    indexing: {
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    },
    search: {
      defaultLimit: 10,
      maxLimit: 100,
      includeCleanOnly: false,
    },
    server: {
      host: 'localhost',
      port: 24280,
      protocol: 'json-rpc',
    },
    storage: {
      documentsPath: process.cwd(),
      indexPath: process.cwd(),
      cachePath: process.cwd(),
    },
    worker: {
      enabled: false,
      interval: 1000,
      maxConcurrent: 1,
    },
    watcher: {
      enabled: false,
      debounceMs: 100,
      awaitWriteFinishMs: 100,
    },
  };
}


describe('WatcherProcess .gitignore integration', () => {
  it('keeps an indexed document when ignored, then removes it on file deletion', { timeout: 60000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-index-'));
    const root = path.join(tmp, 'project');
    await fs.mkdir(root);
    const config = createConfig();
    config.project.root = root;
    config.files.ignoreGitignore = true;
    config.watcher.enabled = true;
    config.worker.enabled = true;
    const storage = new FileStorage({ basePath: path.join(tmp, 'storage') });
    const db = new DBEngine({ dbPath: path.join(tmp, 'index'), embeddingUrl: process.env.TEST_EMBEDDING_URL });
    const watcherProcess = new WatcherProcess(config, storage, db);
    const internal = watcherProcess as unknown as {
      watcher: { start(): Promise<void>; stop(): Promise<void> };
      indexWorker: { processNextRequests(): Promise<void> };
    };
    const waitFor = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for watcher processing');
    };
    try {
      await db.connect();
      await internal.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const file = path.join(root, 'private.md');
      await fs.writeFile(file, '# Private\n\nIndexed content');
      await waitFor(async () => (await db.findIndexRequests({ documentPath: 'private.md', status: 'pending' })).length > 0);
      await internal.indexWorker.processNextRequests();
      expect((await db.getSectionsByPath('private.md')).sections.length).toBeGreaterThan(0);

      await internal.watcher.stop();
      await fs.writeFile(path.join(root, '.gitignore'), 'private.md\n');
      await internal.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await storage.get('private.md')).not.toBeNull();
      expect((await db.getSectionsByPath('private.md')).sections.length).toBeGreaterThan(0);
      await fs.writeFile(file, '# Ignored change');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await storage.get('private.md'))?.content).toContain('Indexed content');
      await fs.unlink(file);
      await waitFor(async () => (await storage.get('private.md')) === null);
      expect((await db.getSectionsByPath('private.md')).sections).toHaveLength(0);
    } finally {
      await internal.watcher.stop();
      await db.disconnect();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
