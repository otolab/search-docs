import type { ToolSpec } from '@modular-prompt/process';
import type { SearchDocsClient } from '@search-docs/client';
import type { SearchAgentContext, Chunk } from './context.js';

/**
 * search-docs用のToolSpec[]を生成する
 */
export function createSearchTools(client: SearchDocsClient): ToolSpec<SearchAgentContext>[] {
  return [
    {
      definition: {
        name: 'search',
        description: 'Hybrid vector search over document sections. Returns ranked results with preview.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            depth: { type: 'number', description: 'Max section depth (0-3). 0=document, 1=chapter, 2=section, 3=subsection' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
          },
          required: ['query'],
        },
      },
      handler: async (args, context) => {
        const { query, depth, limit } = args as { query: string; depth?: number; limit?: number };
        const response = await client.search({
          query,
          options: { depth, limit, previewLines: 8 },
        });
        // チャンクをcontextに追加
        for (const r of response.results) {
          context.chunks[r.id] = {
            id: r.id,
            documentPath: r.documentPath,
            heading: r.heading,
            content: r.content,
            score: r.score,
            tokenCount: r.tokenCount,
          };
        }
        return response.results.map(r => ({
          id: r.id,
          heading: r.heading,
          documentPath: r.documentPath,
          score: r.score,
          depth: r.depth,
          tokenCount: r.tokenCount,
          preview: r.content.slice(0, 500),
        }));
      },
    },
    {
      definition: {
        name: 'get_document',
        description: 'Get full content of a section or document by ID or path.',
        parameters: {
          type: 'object',
          properties: {
            sectionId: { type: 'string', description: 'Section ID (from search results)' },
            path: { type: 'string', description: 'Document path' },
          },
        },
      },
      handler: async (args, context) => {
        const { sectionId, path } = args as { sectionId?: string; path?: string };
        const response = await client.getDocument({ sectionId, path });
        if (!response.document) {
          return { error: 'Document not found' };
        }
        // セクション指定の場合、チャンクとして追加
        if (response.section) {
          const s = response.section;
          context.chunks[s.id] = {
            id: s.id,
            documentPath: s.documentPath,
            heading: s.heading,
            content: s.content,
            tokenCount: s.tokenCount,
          };
        }
        return {
          path: response.document.path,
          title: response.document.metadata?.title,
          content: response.section?.content ?? response.document.content,
        };
      },
    },
    {
      definition: {
        name: 'get_outline',
        description: 'Get table of contents structure of a document. Shows section headings, token counts, and IDs.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Document path' },
            sectionId: { type: 'string', description: 'Section ID (show outline under this section)' },
          },
        },
      },
      handler: async (args) => {
        const { path, sectionId } = args as { path?: string; sectionId?: string };
        const response = await client.getOutline({ path, sectionId });
        return response.items.map(item => ({
          number: item.number,
          heading: item.heading,
          tokens: item.tokens,
          id: item.id,
        }));
      },
    },
    {
      definition: {
        name: 'prune',
        description: 'Remove irrelevant chunks from context to free up token budget.',
        parameters: {
          type: 'object',
          properties: {
            chunkIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Section IDs to remove from context',
            },
          },
          required: ['chunkIds'],
        },
      },
      handler: async (args, context) => {
        const { chunkIds } = args as { chunkIds: string[] };
        const idSet = new Set(chunkIds);
        let removed = 0;

        // chunksから削除
        for (const id of chunkIds) {
          if (context.chunks[id]) {
            delete context.chunks[id];
            removed++;
          }
        }

        // messagesからも該当チャンクを含むtool resultを除去
        if (context.messages) {
          context.messages = context.messages.filter(msg => {
            if ('role' in msg && msg.role === 'tool' && 'value' in msg) {
              // tool resultの値にchunkIdが含まれていたら除去
              const valueStr = typeof msg.value === 'string' ? msg.value : JSON.stringify(msg.value);
              for (const id of idSet) {
                if (valueStr.includes(id)) return false;
              }
            }
            return true;
          });
        }

        return { removed, remaining: Object.keys(context.chunks).length };
      },
    },
  ];
}
