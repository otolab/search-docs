import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DBEngine } from '@search-docs/db-engine';
import { FileStorage } from '@search-docs/storage';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { indexSynchronousSources, prepareSynchronousSources } from '../../rebuild/synchronous-index.js';

const temporary: string[] = [];
let http: Server | undefined;
afterEach(async () => {
  if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
  http = undefined;
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synchronous-index-'));
  temporary.push(root);
  await mkdir(path.join(root, '.search-docs'));
  await writeFile(path.join(root, 'first.md'), '# First\n\nFirst document');
  await writeFile(path.join(root, 'second.md'), '# Second\n\nSecond document');
  return { root, forbiddenPath: path.join(root, '.search-docs/index'), files: { ...DEFAULT_CONFIG.files, sources: [path.join(root, '*.md')], respectGitignore: false } };
}
async function embedding(fail = false, zero = false): Promise<string> {
  http = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200).end(JSON.stringify({ vectorDimension: 256, model: 'test' })); return; }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (fail) { res.writeHead(500).end('failure'); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; dimensions: number };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings: body.input.map(() => Array.from({ length: body.dimensions }, (_, i) => !zero && i === 0 ? 1 : 0)) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http!.once('error', reject);
    http!.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  return `http://127.0.0.1:${address.port}`;
}

describe('未公開の同期索引化', () => {
  it('絶対 glob の対象を実 DB に保存し、読み戻しと停止を待つ', async () => {
    const config = await fixture();
    const prepared = await prepareSynchronousSources(config);
    expect(prepared.sources.map(source => source.path)).toEqual(expect.arrayContaining(['first.md', 'second.md']));
    const url = await embedding();
    const engine = new DBEngine({ dbPath: config.forbiddenPath, embeddingUrl: url });
    const storage = new FileStorage({ basePath: path.join(config.root, '.search-docs/documents') });
    await indexSynchronousSources({ prepared, engine, storage, indexing: DEFAULT_CONFIG.indexing });
    expect((await storage.get('first.md'))?.content).toContain('First document');
    const verify = new DBEngine({ dbPath: config.forbiddenPath, embeddingUrl: url });
    try {
      await verify.connect();
      for (const source of prepared.sources) expect((await verify.findSectionsByPathAndHash(source.path, source.hash)).length).toBeGreaterThan(0);
    } finally { await verify.disconnect(); }
  }, 60000);
  it('埋め込み失敗を成功と扱わず、子プロセスを停止する', async () => {
    const config = await fixture();
    const prepared = await prepareSynchronousSources(config);
    const engine = new DBEngine({ dbPath: config.forbiddenPath, embeddingUrl: await embedding(true) });
    await expect(indexSynchronousSources({ prepared, engine, storage: new FileStorage({ basePath: path.join(config.root, '.search-docs/documents') }), indexing: DEFAULT_CONFIG.indexing })).rejects.toThrow();
    await engine.disconnect();
  }, 60000);
  it('ルート外の glob とサイズ超過を拒否する', async () => {
    const config = await fixture();
    await expect(prepareSynchronousSources({ ...config, files: { ...config.files, sources: ['../outside/*.md'] } })).rejects.toThrow(/プロジェクト外/);
    await expect(prepareSynchronousSources({ ...config, files: { ...config.files, sources: ['/outside/*.md'] } })).rejects.toThrow(/プロジェクト外/);
    await expect(prepareSynchronousSources({ ...config, files: { ...config.files, maxFileSize: 1 } })).rejects.toThrow(/索引化できません/);
  });
  it('プロジェクト内の絶対 glob と絶対除外 glob を一緒に扱う', async () => {
    const config = await fixture();
    const files = { ...config.files, sources: [path.join(config.root, '*.md'), `!${path.join(config.root, 'second.md')}`] };
    const prepared = await prepareSynchronousSources({ ...config, files });
    expect(prepared.sources.map(source => source.path)).toEqual(['first.md']);
    const excluded = await prepareSynchronousSources({
      ...config,
      files: { ...config.files, sources: [path.join(config.root, '*.md')], exclude: [path.join(config.root, 'second.md')] },
    });
    expect(excluded.sources.map(source => source.path)).toEqual(['first.md']);
  });
  it('プロジェクト内のリンクを経由した外部文書を拒否する', async () => {
    const config = await fixture();
    const external = await mkdtemp(path.join(tmpdir(), 'external-source-'));
    temporary.push(external);
    await writeFile(path.join(external, 'outside.md'), '# Outside');
    await symlink(path.join(external, 'outside.md'), path.join(config.root, 'linked.md'));
    await expect(prepareSynchronousSources(config)).rejects.toThrow(/プロジェクト外.*削除前の確認/);
  });
  it('worker が上限超過を検出したら再構築は失敗する', async () => {
    const config = await fixture();
    const prepared = await prepareSynchronousSources(config);
    const engine = new DBEngine({ dbPath: config.forbiddenPath, embeddingUrl: await embedding(), maxBatchTokens: 1 });
    await expect(indexSynchronousSources({
      prepared, engine, storage: new FileStorage({ basePath: path.join(config.root, '.search-docs/documents') }), indexing: DEFAULT_CONFIG.indexing,
    })).rejects.toThrow(/oversized section/);
  }, 60000);
  it('embedding がゼロベクトルを返したら再構築は失敗する', async () => {
    const config = await fixture();
    const prepared = await prepareSynchronousSources(config);
    const engine = new DBEngine({ dbPath: config.forbiddenPath, embeddingUrl: await embedding(false, true) });
    await expect(indexSynchronousSources({
      prepared, engine, storage: new FileStorage({ basePath: path.join(config.root, '.search-docs/documents') }), indexing: DEFAULT_CONFIG.indexing,
    })).rejects.toThrow(/zero vector/);
  }, 60000);
  it('DB の停止に失敗した場合は成功しない', async () => {
    const config = await fixture();
    const prepared = await prepareSynchronousSources({ ...config, files: { ...config.files, sources: ['missing/*.md'] } });
    const engine = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => { throw new Error('stop failed'); }),
    } as unknown as DBEngine;
    await expect(indexSynchronousSources({
      prepared, engine, storage: new FileStorage({ basePath: path.join(config.root, '.search-docs/documents') }), indexing: DEFAULT_CONFIG.indexing,
    })).rejects.toThrow(/停止を確認できません/);
  });
});
