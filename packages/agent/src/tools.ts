import type { ToolSpec } from '@modular-prompt/process';
import type { SearchDocsClient } from '@search-docs/client';
import type { SearchAgentContext } from './context.js';

/**
 * search-docs用のToolSpec[]を生成する
 *
 * ツール名はcontext-1モデルの学習データに合わせている。
 */
export function createSearchTools(client: SearchDocsClient): ToolSpec<SearchAgentContext>[] {
  return [
    {
      definition: {
        name: 'search_corpus',
        description: 'Hybrid BM25 + dense vector search via reciprocal rank fusion (RRF). Returns ranked results with preview.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
      handler: async (args, context) => {
        const { query } = args as { query: string };
        const response = await client.search({
          query,
          options: { depth: 0, limit: 5, previewLines: 3 },
        });
        if (response.results.length === 0) return 'No results found.';
        for (const r of response.results) {
          context.chunks[r.id] = { id: r.id, documentPath: r.documentPath, heading: r.heading, content: r.content, score: r.score };
        }
        return response.results.map((r, i) =>
          `[${i + 1}] ${r.heading} (${r.documentPath}, document_id=${r.id})\n${r.content.slice(0, 150)}`
        ).join('\n\n');
      },
    },
    {
      definition: {
        name: 'read_document',
        description: 'Read the full content of a document by ID.',
        parameters: {
          type: 'object',
          properties: {
            doc_id: { type: 'string', description: 'Document or section ID' },
          },
          required: ['doc_id'],
        },
      },
      handler: async (args, context) => {
        const { doc_id } = args as { doc_id: string };
        const response = await client.getDocument({ sectionId: doc_id });
        if (!response.section && !response.document) {
          return 'Document not found.';
        }
        const content = response.section?.content ?? response.document?.content ?? '';
        const heading = response.section?.heading ?? response.document?.path ?? '';
        if (response.section) {
          context.chunks[response.section.id] = { id: response.section.id, documentPath: response.section.documentPath, heading, content };
        }
        return `${heading}\n\n${content}`;
      },
    },
    {
      definition: {
        name: 'grep_corpus',
        description: 'Regex search over the corpus. Returns matching sections.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
          },
          required: ['pattern'],
        },
      },
      // TODO: 実際のRegex検索を実装する（現在はsearchで代用しているが、descriptionと実態が一致していない）
      handler: async () => {
        return 'grep_corpus is not yet implemented. Use search_corpus instead.';
      },
    },
    {
      definition: {
        name: 'prune_chunks',
        description: 'Removes specified chunks from the conversation context.',
        parameters: {
          type: 'object',
          properties: {
            chunk_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Chunk IDs to remove from context.',
            },
          },
          required: ['chunk_ids'],
        },
      },
      handler: async (args, context) => {
        const { chunk_ids } = args as { chunk_ids: string[] };
        const idSet = new Set(chunk_ids);
        let removed = 0;

        // chunks から削除
        if (context.chunks) {
          for (const id of idSet) {
            if (id in context.chunks) {
              delete context.chunks[id];
              removed++;
            }
          }
        }

        // messages から該当 tool result を除去
        if (context.messages) {
          context.messages = context.messages.filter(msg => {
            if ('role' in msg && msg.role === 'tool' && 'value' in msg) {
              const valueStr = typeof msg.value === 'string' ? msg.value : JSON.stringify(msg.value);
              for (const id of idSet) {
                if (valueStr.includes(id)) return false;
              }
            }
            return true;
          });
        }

        const remaining = context.chunks ? Object.keys(context.chunks).length : 0;
        return { removed, remaining };
      },
    },
  ];
}
