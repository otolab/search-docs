import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DBEngine, MaintenanceLock } from '@search-docs/db-engine';
import { DEFAULT_CONFIG } from '@search-docs/types';

describe.skipIf(process.platform === 'win32')('CLI 再構築と purge の実プロセス', () => {
  it('確認なしと不明ファイルを拒否し、実 DB の再構築後に purge できる', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'recreate-cli-'));
    let failEmbedding = false;
    const embedding = createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200).end(JSON.stringify({ vectorDimension: 256, model: 'test' })); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; dimensions: number };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings: body.input.map(() => Array.from({ length: body.dimensions }, (_, i) => !failEmbedding && i === 0 ? 1 : 0)) }));
      });
    });
    await new Promise<void>((resolve, reject) => { embedding.once('error', reject); embedding.listen(0, '127.0.0.1', resolve); });
    const address = embedding.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    const url = `http://127.0.0.1:${address.port}`;
    const executable = path.resolve('dist/index.js');
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [executable, ...args], { cwd: root, env: { ...process.env, UV_NO_SYNC: '1', UV_CACHE_DIR: '/tmp/search-docs-uv-cache', EMBEDDING_URL: url }, maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    try {
      await mkdir(path.join(root, '.search-docs/index'), { recursive: true });
      await writeFile(path.join(root, 'source.md'), '# Title\n\nDocument');
      await writeFile(path.join(root, '.search-docs.json'), JSON.stringify({ ...DEFAULT_CONFIG, project: { name: 'test', root }, files: { ...DEFAULT_CONFIG.files, sources: ['*.md'], respectGitignore: false }, indexing: { ...DEFAULT_CONFIG.indexing, embeddingUrl: url } }));
      await expect(run('index', 'recreate')).rejects.toThrow();
      const unknown = path.join(root, '.search-docs/index/unknown.txt');
      await writeFile(unknown, 'original');
      await expect(run('index', 'recreate', '--confirm-isolated')).rejects.toThrow();
      expect(await readFile(unknown, 'utf8')).toBe('original');
      await rm(unknown);
      await run('index', 'recreate', '--confirm-isolated');
      const engine = new DBEngine({ dbPath: path.join(root, '.search-docs/index'), embeddingUrl: url });
      try { await engine.connect(); expect((await engine.getSectionsByPath('source.md')).sections.length).toBeGreaterThan(0); } finally { await engine.disconnect(); }
      await run('index', 'purge', '--confirm-isolated');
      expect(await readdir(path.join(root, '.search-docs/index'))).toEqual([]);
      expect(await readFile(path.join(root, 'source.md'), 'utf8')).toContain('Document');
      failEmbedding = true;
      try {
        await run('index', 'recreate', '--confirm-isolated');
        throw new Error('索引化失敗が成功扱いになりました');
      } catch (error) {
        const failure = error as Error & { killed?: boolean; stderr?: string };
        expect(failure.killed).not.toBe(true);
        expect(failure.stderr).toContain('zero vector');
      }
      const lock = new MaintenanceLock(path.join(root, '.search-docs/.search-docs-maintenance'));
      await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
      failEmbedding = false;
      await run('index', 'recreate', '--confirm-isolated');
      const release = await lock.acquireShared();
      await release();
    } finally {
      await new Promise<void>((resolve, reject) => embedding.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
