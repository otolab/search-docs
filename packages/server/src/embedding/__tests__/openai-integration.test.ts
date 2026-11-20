import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DBEngine } from '@search-docs/db-engine';
import { ConfigLoader } from '@search-docs/config';
import { EmbeddingServerProcess } from '../embedding-server-process.js';
import { prepareEmbeddingOptions } from '../providers.js';

let server: Server | undefined;
let engine: DBEngine | undefined;
let dbPath: string | undefined;
afterEach(async () => {
  engine?.disconnect();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (dbPath) await rm(dbPath, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('indexes and searches with OpenAI-compatible embeddings and rejects a model change', async () => {
  let requests = 0;
  server = createServer((request, response) => {
    expect(request.url === '/v1/embeddings' || request.url === '/other/embeddings').toBe(true);
    expect(request.headers.authorization).toBe('Bearer secret-test-key');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const data = JSON.parse(body) as { input: string[]; dimensions: number };
      requests++;
      expect(data.dimensions).toBe(3);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: data.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  dbPath = await mkdtemp(join(tmpdir(), 'search-docs-openai-'));
  const configPath = join(dbPath, '.search-docs.json');
  vi.stubEnv('TEST_OPENAI_KEY', 'secret-test-key');
  await writeFile(configPath, JSON.stringify({ indexing: { vectorDimension: 3, embedding: { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'example', apiKey: '${env:TEST_OPENAI_KEY}' } } }));
  const config = await ConfigLoader.load(configPath);
  const embedding = config.indexing.embedding!;
  if (embedding.provider !== 'openai-compatible') throw new Error('wrong provider');
  const process = new EmbeddingServerProcess({ embedding, dimension: config.indexing.vectorDimension });
  const embeddingUrl = await process.start();
  expect(process.isExternal()).toBe(true);
  const options = { dbPath, embeddingUrl, embeddingDimension: config.indexing.vectorDimension, embeddingOptions: prepareEmbeddingOptions(embedding), embeddingProvider: embedding.provider, embeddingModel: embedding.model };
  engine = new DBEngine(options);
  await engine.connect();
  await engine.addSections([{ id: 'one', parentId: null, documentPath: 'test.md', heading: '見出し', depth: 1, content: '日本語の文書', tokenCount: 10, order: 0, isDirty: false, documentHash: 'hash', startLine: 1, endLine: 2, sectionNumber: [1], createdAt: new Date(), updatedAt: new Date() }]);
  expect((await engine.search({ query: '文書' })).results[0].documentPath).toBe('test.md');
  expect(requests).toBeGreaterThanOrEqual(3);
  engine.disconnect();
  engine = new DBEngine(options);
  await engine.connect();
  expect((await engine.search({ query: '文書' })).results[0].documentPath).toBe('test.md');
  engine.disconnect();
  engine = new DBEngine({ ...options, embeddingUrl: `http://127.0.0.1:${address.port}/other` });
  const mismatch = await Promise.allSettled([engine.connect(), engine.waitForConnection()]);
  expect(mismatch.every((result) => result.status === 'rejected')).toBe(true);
  expect(engine.getConnectionState().error?.message).toContain('differs from the index');
  engine.disconnect();
  engine = new DBEngine({ ...options, embeddingOptions: { ...options.embeddingOptions, model: 'different' }, embeddingModel: 'different' });
  const results = await Promise.allSettled([engine.connect(), engine.waitForConnection()]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(engine.getConnectionState().error?.message).toContain('differs from the index');
}, 30000);
