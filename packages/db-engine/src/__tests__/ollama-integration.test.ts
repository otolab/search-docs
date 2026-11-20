import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DBEngine } from '../typescript/index.js';

let server: Server | undefined;
let engine: DBEngine | undefined;
let dbPath: string | undefined;
afterEach(async () => {
  engine?.disconnect();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (dbPath) await rm(dbPath, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('indexes and searches through DBEngine and rejects a different model on restart', async () => {
  let digest = 'sha256:first';
  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'example:latest', digest }] }));
    } else if (request.url === '/api/embed') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const input = JSON.parse(body) as { input: string[] };
        response.end(JSON.stringify({ embeddings: input.input.map(() => [0.1, 0.2, 0.3]) }));
      });
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  dbPath = await mkdtemp(join(tmpdir(), 'search-docs-ollama-'));
  vi.stubEnv('EMBEDDING_MODEL', 'example');
  const options = { dbPath, embeddingUrl: `http://127.0.0.1:${address.port}`, embeddingDimension: 3 };
  engine = new DBEngine(options);
  await engine.connect();
  await engine.addSections([{
    id: 'one', documentPath: 'test.md', heading: '見出し', depth: 1,
    content: '日本語の文書', tokenCount: 10, order: 0, isDirty: false,
    documentHash: 'hash', startLine: 1, endLine: 2, sectionNumber: [1],
    createdAt: new Date(), updatedAt: new Date(),
  }]);
  expect((await engine.search({ query: '文書' })).results[0].documentPath).toBe('test.md');
  engine.disconnect();
  digest = 'sha256:second';
  engine = new DBEngine(options);
  const connection = engine.connect();
  const ready = engine.waitForConnection();
  const results = await Promise.allSettled([connection, ready]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(engine.getConnectionState().error?.message).toContain('differs from the index');
}, 30000);
