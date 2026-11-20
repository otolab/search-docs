import type { EmbeddingConfig } from '@search-docs/types';

type ExternalConfig = Exclude<EmbeddingConfig, { provider: 'builtin' }>;

export type EmbeddingProvider = {
  prepare(config: ExternalConfig): Record<string, unknown>;
  url(config: ExternalConfig): string;
  probe(config: ExternalConfig, dimension: number, timeoutMs: number): Promise<void>;
};

function secret(value: string | undefined): string | undefined {
  if (!value) return process.env.EMBEDDING_API_KEY;
  const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!match) return value;
  const resolved = process.env[match[1]];
  if (!resolved) throw new Error(`Embedding API key environment variable ${match[1]} is not set`);
  return resolved;
}

const providers: Record<string, EmbeddingProvider> = {
  'ollama-compat': {
    prepare: (config) => ({ ...config, model: (config as Extract<ExternalConfig, { provider: 'ollama-compat' }>).model || process.env.EMBEDDING_MODEL }),
    url: (config) => (config as Extract<ExternalConfig, { provider: 'ollama-compat' }>).url,
    async probe(config, dimension, timeoutMs) {
      const item = config as Extract<ExternalConfig, { provider: 'ollama-compat' }>;
      const model = item.model || process.env.EMBEDDING_MODEL;
      if (!model) throw new Error('Ollama requires an explicit model or EMBEDDING_MODEL');
      await probe(`${item.url.replace(/\/$/, '')}/api/embed`, { model, input: ['search-docs readiness probe'], dimensions: dimension }, dimension, false, undefined, timeoutMs);
    },
  },
  'openai-compatible': {
    prepare: (config) => ({ ...config, apiKey: secret((config as Extract<ExternalConfig, { provider: 'openai-compatible' }>).apiKey) }),
    url: (config) => (config as Extract<ExternalConfig, { provider: 'openai-compatible' }>).baseUrl,
    async probe(config, dimension, timeoutMs) {
      const item = config as Extract<ExternalConfig, { provider: 'openai-compatible' }>;
      await probe(`${item.baseUrl.replace(/\/$/, '')}/embeddings`, { model: item.model, input: ['search-docs readiness probe'], dimensions: dimension }, dimension, true, secret(item.apiKey), timeoutMs);
    },
  },
};

export function registerEmbeddingProvider(id: string, provider: EmbeddingProvider): void {
  providers[id] = provider;
}

async function probe(url: string, body: object, dimension: number, openai: boolean, apiKey: string | undefined, timeoutMs: number): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Embedding provider is unavailable');
  }
  if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}`);
  let data: { embeddings?: unknown; data?: { index?: unknown; embedding?: unknown }[] };
  try {
    data = await response.json() as typeof data;
  } catch {
    throw new Error('Embedding provider returned invalid JSON');
  }
  if (openai && (!Array.isArray(data.data) || data.data.length !== 1 || data.data[0]?.index !== 0)) {
    throw new Error('Embedding provider returned an invalid response index');
  }
  const vectors = openai ? data.data?.map((item) => item.embedding) : data.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== 1 || !Array.isArray(vectors[0]) || vectors[0].length !== dimension || !vectors[0].every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`Embedding provider returned an invalid vector; expected dimension ${dimension}`);
  }
}

export async function startExternalEmbedding(config: ExternalConfig, dimension: number, timeoutMs = 10000): Promise<string> {
  const provider = providers[config.provider];
  await provider.probe(config, dimension, timeoutMs);
  return provider.url(config);
}

export function prepareEmbeddingOptions(config: EmbeddingConfig | undefined): Record<string, unknown> | undefined {
  if (!config) return undefined;
  if (config.provider === 'builtin') return { ...config };
  return providers[config.provider].prepare(config);
}
