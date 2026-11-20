import { afterEach, describe, expect, it, vi } from 'vitest';
import { startExternalEmbedding } from '../providers.js';
import { EmbeddingServerProcess } from '../embedding-server-process.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('external embedding providers', () => {
  it('probes OpenAI without spawning and resolves the key from the environment', async () => {
    vi.stubEnv('TEST_API_KEY', 'secret-test-value');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const server = new EmbeddingServerProcess({ embedding: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test', apiKey: '${env:TEST_API_KEY}' }, dimension: 3 });
    expect(await server.start()).toBe('https://example.test/v1');
    expect(server.isExternal()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/embeddings', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer secret-test-value' }) }));
    await server.stop();
  });

  it('parses Ollama embeddings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }))));
    await expect(startExternalEmbedding({ provider: 'ollama-compat', url: 'http://localhost:11434', model: 'test' }, 3)).resolves.toBe('http://localhost:11434');
  });

  it.each([
    ['dimension mismatch', { data: [{ index: 0, embedding: [1, 2] }] }],
    ['invalid values', { data: [{ index: 0, embedding: [1, null, 3] }] }],
  ])('rejects %s', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(startExternalEmbedding({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test' }, 3)).rejects.toThrow('expected dimension 3');
  });

  it('rejects a missing or incorrect OpenAI response index', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 1, embedding: [1, 2, 3] }] }))));
    await expect(startExternalEmbedding({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test' }, 3)).rejects.toThrow('invalid response index');
  });

  it('does not expose response bodies or keys on errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-test-value', { status: 401 })));
    await expect(startExternalEmbedding({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test', apiKey: 'secret-test-value' }, 3)).rejects.toThrow('HTTP 401');
  });
});

it('validates explicit settings and preserves provider configuration while loading', async () => {
  const { ConfigLoader, validateConfig } = await import('@search-docs/config');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'embedding-config-'));
  try {
    const file = join(dir, '.search-docs.json');
    await writeFile(file, JSON.stringify({ indexing: { vectorDimension: 3, embedding: { provider: 'openai-compatible', providerOptions: { baseUrl: 'https://example.test/v1', model: 'example', apiKey: '${env:KEY}' } } } }));
    const config = await ConfigLoader.load(file);
    expect(config.indexing.embedding).toEqual(expect.objectContaining({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'example', apiKey: '${env:KEY}' }));
    expect(() => validateConfig({ indexing: { embedding: { provider: 'unknown' } } })).toThrow('provider is unknown');
    expect(() => validateConfig({ indexing: { embedding: { provider: 'openai-compatible', baseUrl: 'https://user:password@example.test/v1', model: 'example' } } })).toThrow('without credentials');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('accepts a provider-specific environment option and authentication through registered adapters', async () => {
  const { ConfigLoader, registerEmbeddingConfig } = await import('@search-docs/config');
  const { registerEmbeddingProvider, prepareEmbeddingOptions } = await import('../providers.js');
  registerEmbeddingConfig('test-provider', ['region', 'credentialEnv']);
  let received: Record<string, unknown> | undefined;
  registerEmbeddingProvider('test-provider', {
    prepare: (config) => {
      const options = config as unknown as { region: string; credentialEnv: string };
      return { region: options.region, token: process.env[options.credentialEnv] };
    },
    url: () => 'https://test.example',
    probe: async (config) => { received = config as unknown as Record<string, unknown>; },
  });
  vi.stubEnv('EMBEDDING_PROVIDER', 'test-provider');
  vi.stubEnv('EMBEDDING_OPTIONS', JSON.stringify({ region: 'asia', credentialEnv: 'TEST_CUSTOM_TOKEN' }));
  vi.stubEnv('TEST_CUSTOM_TOKEN', 'private-value');
  const config = ConfigLoader.getDefaultConfig().indexing.embedding!;
  const options = prepareEmbeddingOptions(config);
  expect(options).toEqual({ region: 'asia', token: 'private-value' });
  const server = new EmbeddingServerProcess({ embedding: config, dimension: 3 });
  expect(await server.start()).toBe('https://test.example');
  expect(server.isExternal()).toBe(true);
  expect(received).toMatchObject({ region: 'asia', credentialEnv: 'TEST_CUSTOM_TOKEN' });
});
