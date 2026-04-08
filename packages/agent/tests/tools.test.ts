import { describe, it, expect } from 'vitest';
import { createSearchTools } from '../src/tools.js';
import type { SearchAgentContext } from '../src/context.js';

// モッククライアント
function mockClient() {
  return {
    search: async () => ({
      results: [
        {
          id: 'sec-001', documentPath: 'docs/a.md', documentHash: 'h1',
          heading: 'Section A', depth: 1, content: 'Content of section A',
          score: 0.95, isDirty: false, tokenCount: 100,
          startLine: 1, endLine: 10, sectionNumber: [1],
        },
        {
          id: 'sec-002', documentPath: 'docs/b.md', documentHash: 'h2',
          heading: 'Section B', depth: 2, content: 'Content of section B',
          score: 0.80, isDirty: false, tokenCount: 200,
          startLine: 1, endLine: 20, sectionNumber: [1, 2],
        },
      ],
      total: 2,
      took: 50,
    }),
    getDocument: async () => ({
      document: { path: 'docs/a.md', content: 'Full doc', metadata: { title: 'Doc A', createdAt: new Date(), updatedAt: new Date(), fileHash: 'h' } },
      section: { id: 'sec-001', documentPath: 'docs/a.md', heading: 'Section A', depth: 1, content: 'Section content', tokenCount: 100, vector: new Float32Array(), parentId: null, order: 0, isDirty: false, documentHash: 'h', createdAt: new Date(), updatedAt: new Date(), startLine: 1, endLine: 10, sectionNumber: [1] },
    }),
    healthCheck: async () => ({}),
    getStatus: async () => ({}),
    indexDocument: async () => ({ success: true, sectionsCreated: 0 }),
    rebuildIndex: async () => ({ success: true }),
    shutdown: async () => {},
  } as any;
}

function makeContext(): SearchAgentContext {
  return { query: 'test', chunks: {}, messages: [] };
}

describe('createSearchTools', () => {
  const tools = createSearchTools(mockClient());

  it('4つのツールが定義される', () => {
    expect(tools).toHaveLength(4);
    const names = tools.map(t => t.definition.name);
    expect(names).toEqual(['search_corpus', 'read_document', 'grep_corpus', 'prune_chunks']);
  });

  describe('search_corpus handler', () => {
    it('検索結果をフォーマットして返す', async () => {
      const context = makeContext();
      const searchTool = tools.find(t => t.definition.name === 'search_corpus')!;
      const result = await searchTool.handler({ query: 'test query' }, context);

      expect(typeof result).toBe('string');
      expect(result as string).toContain('Section A');
      expect(result as string).toContain('sec-001');
      expect(result as string).toContain('Section B');
    });

    it('結果がない場合はメッセージを返す', async () => {
      const emptyClient = {
        ...mockClient(),
        search: async () => ({ results: [], total: 0, took: 0 }),
      } as any;
      const emptyTools = createSearchTools(emptyClient);
      const searchTool = emptyTools.find(t => t.definition.name === 'search_corpus')!;
      const result = await searchTool.handler({ query: 'nothing' }, makeContext());
      expect(result).toBe('No results found.');
    });
  });

  describe('read_document handler', () => {
    it('ドキュメント内容を返す', async () => {
      const context = makeContext();
      const readTool = tools.find(t => t.definition.name === 'read_document')!;
      const result = await readTool.handler({ doc_id: 'sec-001' }, context);

      expect(typeof result).toBe('string');
      expect(result as string).toContain('Section A');
      expect(result as string).toContain('Section content');
    });
  });

  describe('grep_corpus handler', () => {
    it('未実装メッセージを返す', async () => {
      const context = makeContext();
      const grepTool = tools.find(t => t.definition.name === 'grep_corpus')!;
      const result = await grepTool.handler({ pattern: 'section' }, context);

      expect(typeof result).toBe('string');
      expect(result as string).toContain('not yet implemented');
    });
  });

  describe('prune_chunks handler', () => {
    it('chunksから指定IDを削除する', async () => {
      const context = makeContext();
      context.chunks = {
        'sec-001': { id: 'sec-001', documentPath: 'a.md', heading: 'A', content: 'Content A' },
        'sec-002': { id: 'sec-002', documentPath: 'b.md', heading: 'B', content: 'Content B' },
        'sec-003': { id: 'sec-003', documentPath: 'c.md', heading: 'C', content: 'Content C' },
      };

      const pruneTool = tools.find(t => t.definition.name === 'prune_chunks')!;
      const result = await pruneTool.handler({ chunk_ids: ['sec-001', 'sec-003'] }, context);

      expect((result as any).removed).toBe(2);
      expect((result as any).remaining).toBe(1);
      expect(context.chunks['sec-001']).toBeUndefined();
      expect(context.chunks['sec-002']).toBeDefined();
      expect(context.chunks['sec-003']).toBeUndefined();
    });

    it('messagesからも該当tool resultを除去する', async () => {
      const context = makeContext();
      context.chunks = {
        'sec-001': { id: 'sec-001', documentPath: 'a.md', heading: 'A', content: 'A' },
      };
      context.messages = [
        { type: 'message', role: 'assistant', content: 'Let me search' },
        { type: 'message', role: 'tool', toolCallId: 'tc1', name: 'search', kind: 'data', value: JSON.stringify([{ id: 'sec-001' }]) },
        { type: 'message', role: 'tool', toolCallId: 'tc2', name: 'search', kind: 'data', value: JSON.stringify([{ id: 'sec-999' }]) },
      ] as any;

      const pruneTool = tools.find(t => t.definition.name === 'prune_chunks')!;
      await pruneTool.handler({ chunk_ids: ['sec-001'] }, context);

      // sec-001を含むtool resultが除去され、sec-999のは残る
      expect(context.messages).toHaveLength(2);
      expect((context.messages![1] as any).value).toContain('sec-999');
    });

    it('存在しないIDを指定しても安全に動作する', async () => {
      const context = makeContext();
      context.chunks = {
        'sec-001': { id: 'sec-001', documentPath: 'a.md', heading: 'A', content: 'A' },
      };

      const pruneTool = tools.find(t => t.definition.name === 'prune_chunks')!;
      const result = await pruneTool.handler({ chunk_ids: ['nonexistent'] }, context);

      expect((result as any).removed).toBe(0);
      expect((result as any).remaining).toBe(1);
    });
  });
});
