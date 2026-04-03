import { describe, it, expect } from 'vitest';
import { createSearchTools } from '../src/tools.js';
import type { SearchAgentContext } from '../src/context.js';

// searchとget_documentのモッククライアント
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
    getOutline: async () => ({
      items: [
        { number: '1', heading: 'Chapter 1', lines: 50, tokens: 500, id: 'sec-001' },
        { number: '1.1', heading: 'Section 1.1', lines: 20, tokens: 200, id: 'sec-002' },
      ],
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
    expect(names).toEqual(['search', 'get_document', 'get_outline', 'prune']);
  });

  describe('search handler', () => {
    it('検索結果をcontextのchunksに追加する', async () => {
      const context = makeContext();
      const searchTool = tools.find(t => t.definition.name === 'search')!;
      const result = await searchTool.handler({ query: 'test query' }, context);

      expect(Object.keys(context.chunks)).toHaveLength(2);
      expect(context.chunks['sec-001']).toBeDefined();
      expect(context.chunks['sec-001'].heading).toBe('Section A');
      expect(context.chunks['sec-002'].score).toBe(0.80);

      // 戻り値にpreviewが含まれる
      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].id).toBe('sec-001');
    });
  });

  describe('get_document handler', () => {
    it('セクションをcontextのchunksに追加する', async () => {
      const context = makeContext();
      const getDocTool = tools.find(t => t.definition.name === 'get_document')!;
      const result = await getDocTool.handler({ sectionId: 'sec-001' }, context);

      expect(context.chunks['sec-001']).toBeDefined();
      expect(context.chunks['sec-001'].content).toBe('Section content');
      expect((result as any).path).toBe('docs/a.md');
    });
  });

  describe('get_outline handler', () => {
    it('アウトライン項目を返す', async () => {
      const context = makeContext();
      const outlineTool = tools.find(t => t.definition.name === 'get_outline')!;
      const result = await outlineTool.handler({ path: 'docs/a.md' }, context);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].heading).toBe('Chapter 1');
      expect((result as any[])[1].id).toBe('sec-002');
    });
  });

  describe('prune handler', () => {
    it('chunksから指定IDを削除する', async () => {
      const context = makeContext();
      context.chunks = {
        'sec-001': { id: 'sec-001', documentPath: 'a.md', heading: 'A', content: 'Content A' },
        'sec-002': { id: 'sec-002', documentPath: 'b.md', heading: 'B', content: 'Content B' },
        'sec-003': { id: 'sec-003', documentPath: 'c.md', heading: 'C', content: 'Content C' },
      };

      const pruneTool = tools.find(t => t.definition.name === 'prune')!;
      const result = await pruneTool.handler({ chunkIds: ['sec-001', 'sec-003'] }, context);

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

      const pruneTool = tools.find(t => t.definition.name === 'prune')!;
      await pruneTool.handler({ chunkIds: ['sec-001'] }, context);

      // sec-001を含むtool resultが除去され、sec-999のは残る
      expect(context.messages).toHaveLength(2);
      expect((context.messages![1] as any).value).toContain('sec-999');
    });

    it('存在しないIDを指定しても安全に動作する', async () => {
      const context = makeContext();
      context.chunks = {
        'sec-001': { id: 'sec-001', documentPath: 'a.md', heading: 'A', content: 'A' },
      };

      const pruneTool = tools.find(t => t.definition.name === 'prune')!;
      const result = await pruneTool.handler({ chunkIds: ['nonexistent'] }, context);

      expect((result as any).removed).toBe(0);
      expect((result as any).remaining).toBe(1);
    });
  });
});
