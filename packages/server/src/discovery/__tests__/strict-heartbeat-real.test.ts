import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DBEngine } from '@search-docs/db-engine';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { diagnoseStrictConfig } from '../strict-diagnostic.js';

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

describe('実 DB の heartbeat 診断', () => {
  it.each(['missing', 'corrupt'])('%s の場合に既存 DB と文書コピーを変更しない', async condition => {
    const root = await mkdtemp(path.join(tmpdir(), 'strict-heartbeat-real-'));
    const control = path.join(root, '.search-docs');
    const index = path.join(control, 'index');
    await mkdir(path.join(control, 'documents'), { recursive: true });
    const http = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ready: true, model: 'test', vectorDimension: 256 }));
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    const engine = new DBEngine({ dbPath: index, embeddingUrl: `http://127.0.0.1:${address.port}` });
    const config = { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, root }, files: { ...DEFAULT_CONFIG.files, sources: [] } };
    try {
      await engine.connect();
      await engine.disconnect();
      const heartbeat = path.join(index, 'writer_heartbeat.lance');
      await rm(condition === 'missing' ? heartbeat : path.join(heartbeat, '_versions'), { recursive: true });
      const before = await snapshot(control);
      await expect(diagnoseStrictConfig(config)).rejects.toThrow();
      expect(await snapshot(control)).toEqual(before);
      await expect(diagnoseStrictConfig(config, { skipTable: 'writer_heartbeat' })).resolves.toBeUndefined();
      expect(await snapshot(control)).toEqual(before);
    } finally {
      await engine.disconnect();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
