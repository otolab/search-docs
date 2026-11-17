import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader, checkConfigDeprecations } from '@search-docs/config';
import { FileDiscovery } from '../file-discovery.js';
import { WatcherProcess } from '../../watcher/watcher-process.js';
import type { FileStorage } from '@search-docs/storage';
import type { DBEngine } from '@search-docs/db-engine';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(files: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-docs-gitignore-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, '.gitignore'), 'private.md\n');
  await fs.writeFile(path.join(root, 'private.md'), '# Private');
  await fs.writeFile(path.join(root, 'public.md'), '# Public');
  const configPath = path.join(root, '.search-docs.json');
  await fs.writeFile(configPath, JSON.stringify({ files }));
  const config = await ConfigLoader.load(configPath);
  config.project.root = root;
  return { root, config };
}

describe('gitignore configuration', () => {
  it.each([
    [{}, true],
    [{ respectGitignore: true }, true],
    [{ respectGitignore: false }, false],
    [{ ignoreGitignore: true }, true],
    [{ ignoreGitignore: false }, false],
  ])('loads %o and applies it to discovery and indexing', async (files, respects) => {
    const { root, config } = await fixture(files);
    expect(config.files.respectGitignore).toBe(respects);
    const discovered = await new FileDiscovery({ rootDir: root, config: config.files }).findFiles();
    expect(discovered.includes('private.md')).toBe(!respects);
    expect(discovered).toContain('public.md');

    const storage = { get: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const db = { createIndexRequest: vi.fn().mockResolvedValue(undefined) };
    const watcher = new WatcherProcess(config, storage as unknown as FileStorage, db as unknown as DBEngine);
    const rebuild = watcher as unknown as { rebuildIndex: () => Promise<{ documentsProcessed: number }> };
    const result = await rebuild.rebuildIndex();
    expect(result.documentsProcessed).toBe(respects ? 1 : 2);
    expect(storage.save.mock.calls.map((call) => call[0]).sort()).toEqual(respects ? ['public.md'] : ['private.md', 'public.md']);
    expect(db.createIndexRequest).toHaveBeenCalledTimes(respects ? 1 : 2);
  });

  it.each([
    { respectGitignore: true, ignoreGitignore: true },
    { respectGitignore: false, ignoreGitignore: true },
    { respectGitignore: 'true' },
    { ignoreGitignore: 'false' },
  ])('rejects invalid configuration %o', async (files) => {
    await expect(fixture(files)).rejects.toThrow();
  });

  it('reports the old name and preserves the value in migration guidance', () => {
    const deprecations = checkConfigDeprecations({ files: { ignoreGitignore: false } });
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0].field).toBe('files.ignoreGitignore');
    expect(deprecations[0].currentValue).toBe(false);
    expect(deprecations[0].migration).toContain('respectGitignore');
  });
});
