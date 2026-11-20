import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { setupTestEnvironment, type TestEnvironment } from './helpers/test-setup.js';
import type { MCPToolResult } from './helpers/types.js';

let embedding: Server | undefined;
let env: TestEnvironment | undefined;
afterEach(async () => {
  await env?.cleanup();
  if (embedding) await new Promise<void>((resolve) => embedding!.close(() => resolve()));
  vi.unstubAllEnvs();
});

it('keeps MCP available and reports a missing Ollama model while rejecting search', async () => {
  embedding = createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [] }));
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => embedding!.listen(0, '127.0.0.1', resolve));
  const address = embedding.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  vi.stubEnv('EMBEDDING_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('EMBEDDING_MODEL', '');
  env = await setupTestEnvironment({ prefix: 'issue70-mcp-failure', createConfig: true });
  await vi.waitFor(async () => {
    const status = await env!.tester.callTool('get_system_status', {});
    expect((status.result as MCPToolResult).content?.[0]?.text).toContain('explicit EMBEDDING_MODEL');
  }, { timeout: 20000, interval: 200 });
  const status = await env.tester.callTool('get_system_status', {});
  const text = (status.result as MCPToolResult).content?.[0]?.text;
  expect(text).toContain('状態: データベース接続エラー');
  expect(text).toContain('MCPサーバを再起動');
  const index = await env.tester.callTool('index_status', {});
  expect((index.result as MCPToolResult).content?.[0]?.text).toContain('explicit EMBEDDING_MODEL');
  const search = await env.tester.callTool('search', { query: 'test' });
  expect(JSON.stringify(search)).toContain('explicit EMBEDDING_MODEL');
}, 30000);
