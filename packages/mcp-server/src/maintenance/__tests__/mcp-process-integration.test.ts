import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strictMaintenanceLock } from '@search-docs/db-engine';
import { DEFAULT_CONFIG } from '@search-docs/types';

describe.skipIf(process.platform === 'win32')('MCP 実プロセスの保守手順', () => {
  it('受理済み MCP 要求を待って実サービスを停止し、排他を確認して再開する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-maintenance-real-'));
    await mkdir(path.join(root, '.search-docs'));
    const embedding = createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200).end(JSON.stringify({ status: 'ok', ready: true, model: 'test', vectorDimension: 256 })); return; }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => { embedding.once('error', reject); embedding.listen(0, '127.0.0.1', resolve); });
    const address = embedding.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('test-fixtures/maintenance-mcp.mjs'), root, `http://127.0.0.1:${address.port}`],
      stderr: 'pipe', env: { ...process.env as Record<string, string>, UV_NO_SYNC: '1', UV_CACHE_DIR: '/tmp/search-docs-uv-cache' },
    });
    const client = new Client({ name: 'integration-test', version: '1' });
    try {
      await client.connect(transport);
      const pending = client.callTool({ name: 'hold', arguments: {} });
      await new Promise(resolve => setTimeout(resolve, 150));
      let finished = false;
      const maintenance = client.callTool({ name: 'index_purge', arguments: { confirmIsolated: true } }).then(result => { finished = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(finished).toBe(false);
      const probe = await client.callTool({ name: 'probe', arguments: {} });
      expect(probe.isError).toBe(true);
      await client.callTool({ name: 'release', arguments: {} });
      expect((await pending).isError).not.toBe(true);
      const maintenanceResult = await maintenance;
      expect(maintenanceResult.isError, JSON.stringify(maintenanceResult)).not.toBe(true);
      expect((await client.callTool({ name: 'probe', arguments: {} })).isError).not.toBe(true);
      const competing = await (await strictMaintenanceLock({
        projectRoot: root,
        indexPath: DEFAULT_CONFIG.storage.indexPath,
        documentsPath: DEFAULT_CONFIG.storage.documentsPath,
        files: { ...DEFAULT_CONFIG.files, sources: [], respectGitignore: false },
      })).acquireShared();
      try {
        expect((await client.callTool({ name: 'index_purge', arguments: { confirmIsolated: true } })).isError).toBe(true);
        expect((await client.callTool({ name: 'probe', arguments: {} })).isError).not.toBe(true);
      } finally { await competing(); }
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => embedding.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
