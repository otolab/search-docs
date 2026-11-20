import { createMCPTester, type MCPServiceE2ETester } from '@coeiro-operator/mcp-debug';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { MCPToolResult } from './helpers/types.js';

const url = process.env.ISSUE70_REAL_OLLAMA_URL;
it.skipIf(!url)('indexes and searches with real Ollama before and after MCP restart', async () => {
  const project = await mkdtemp(join(tmpdir(), 'issue70-real-ollama-'));
  let tester: MCPServiceE2ETester | undefined;
  vi.stubEnv('EMBEDDING_URL', url!);
  vi.stubEnv('EMBEDDING_MODEL', 'qwen3-embedding:0.6b');
  try {
    await writeFile(join(project, '.search-docs.json'), JSON.stringify({
      files: { sources: ['**/*.md'] }, indexing: { vectorDimension: 256 }, worker: { interval: 200 },
    }));
    await writeFile(join(project, 'sample.md'), '# 宇宙犬\n\n宇宙犬は星の間を旅します。\n');
    const start = async () => {
      const instance = await createMCPTester({
        serverPath: fileURLToPath(new URL('../../dist/server.js', import.meta.url)),
        args: ['--project-dir', project],
      });
      await instance.waitUntilReady();
      return instance;
    };
    tester = await start();
    await vi.waitFor(async () => {
      const result = await tester!.callTool('search', { query: '宇宙犬' });
      expect((result.result as MCPToolResult)?.content?.[0]?.text).toContain('sample.md');
    }, { timeout: 60000, interval: 500 });
    await tester.cleanup();
    tester = await start();
    await vi.waitFor(async () => {
      const result = await tester!.callTool('search', { query: '宇宙犬' });
      expect((result.result as MCPToolResult)?.content?.[0]?.text).toContain('sample.md');
    }, { timeout: 30000, interval: 500 });
  } finally {
    await tester?.cleanup();
    await rm(project, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 120000);
