import { describe, it, expect } from 'vitest';
import { TestDriver } from '@modular-prompt/driver';
import { toolAgentProcess } from '@modular-prompt/process';
import { createSearchTools } from '../../src/tools.js';
import { searchAgentModule } from '../../src/prompt.js';
import { parseSearchAgentOutput } from '../../src/parse.js';
import type { SearchAgentContext } from '../../src/context.js';

/**
 * search-docs clientのモック
 * 固定の検索結果を返す
 */
function mockClient() {
  return {
    search: async (req: any) => ({
      results: [
        {
          id: 'sec-arch-001', documentPath: 'docs/architecture.md', documentHash: 'h1',
          heading: 'System Architecture', depth: 1,
          content: 'The system uses a client-server architecture with JSON-RPC communication.',
          score: 0.95, isDirty: false, tokenCount: 150,
          startLine: 1, endLine: 15, sectionNumber: [1],
        },
        {
          id: 'sec-data-001', documentPath: 'docs/data-model.md', documentHash: 'h2',
          heading: 'Data Model', depth: 1,
          content: 'Documents are stored with metadata and split into sections by heading.',
          score: 0.82, isDirty: false, tokenCount: 200,
          startLine: 1, endLine: 20, sectionNumber: [1],
        },
      ],
      total: 2,
      took: 30,
    }),
    getDocument: async (req: any) => ({
      document: {
        path: 'docs/architecture.md',
        content: 'Full architecture document content...',
        metadata: { title: 'Architecture', createdAt: new Date(), updatedAt: new Date(), fileHash: 'h1' },
      },
      section: req.sectionId ? {
        id: req.sectionId,
        documentPath: 'docs/architecture.md',
        heading: 'System Architecture',
        depth: 1,
        content: 'Detailed architecture section content with more details about the system.',
        tokenCount: 300,
        vector: new Float32Array(),
        parentId: null, order: 0, isDirty: false, documentHash: 'h1',
        createdAt: new Date(), updatedAt: new Date(),
        startLine: 1, endLine: 30, sectionNumber: [1],
      } : undefined,
    }),
    getOutline: async () => ({
      items: [
        { number: '1', heading: 'System Architecture', lines: 30, tokens: 300, id: 'sec-arch-001' },
        { number: '2', heading: 'Data Model', lines: 40, tokens: 400, id: 'sec-data-001' },
      ],
    }),
  } as any;
}

describe('agent integration test', () => {
  it('ツール呼び出し→最終出力の完全なフローが動く', async () => {
    // TestDriver: 1ターン目でsearchツールを呼び、2ターン目で最終出力
    const driver = new TestDriver({
      responses: [
        // Turn 1: searchツールを呼ぶ
        {
          content: 'Let me search for architecture information.',
          toolCalls: [
            { id: 'tc-1', name: 'search', arguments: { query: 'architecture' } },
          ],
        },
        // Turn 2: 結果を見て最終出力
        {
          content: `<Document id={sec-arch-001}>
  <Justification>This section describes the system architecture in detail.</Justification>
</Document>`,
        },
      ],
    });

    const tools = createSearchTools(mockClient());
    const context: SearchAgentContext = { query: 'アーキテクチャについて教えて', chunks: {} };

    const result = await toolAgentProcess(driver, searchAgentModule, context, {
      tools,
      maxTurns: 5,
    });

    // ツール呼び出しが実行され、chunksにデータが蓄積されている
    expect(Object.keys(result.context.chunks).length).toBeGreaterThan(0);
    expect(result.context.chunks['sec-arch-001']).toBeDefined();

    // 最終出力からドキュメントがパースできる
    const documents = parseSearchAgentOutput(result.output, result.context);
    expect(documents).toHaveLength(1);
    expect(documents[0].sectionId).toBe('sec-arch-001');
    expect(documents[0].justification).toContain('system architecture');

    // メタデータ
    expect(result.metadata?.iterations).toBe(2);
    expect(result.metadata?.toolCallLog).toHaveLength(1);
    expect(result.metadata?.toolCallLog[0].name).toBe('search');
  });

  it('pruneツールがcontextからチャンクを除去する', async () => {
    const driver = new TestDriver({
      responses: [
        // Turn 1: search
        {
          content: 'Searching...',
          toolCalls: [
            { id: 'tc-1', name: 'search', arguments: { query: 'data model' } },
          ],
        },
        // Turn 2: prune不要なチャンク
        {
          content: 'Pruning irrelevant chunk.',
          toolCalls: [
            { id: 'tc-2', name: 'prune', arguments: { chunkIds: ['sec-data-001'] } },
          ],
        },
        // Turn 3: 最終出力
        {
          content: `<Document id={sec-arch-001}>
  <Justification>Architecture is the relevant document.</Justification>
</Document>`,
        },
      ],
    });

    const tools = createSearchTools(mockClient());
    const context: SearchAgentContext = { query: 'test', chunks: {} };

    const result = await toolAgentProcess(driver, searchAgentModule, context, {
      tools,
      maxTurns: 5,
    });

    // pruneされたチャンクはcontextから消えている
    expect(result.context.chunks['sec-data-001']).toBeUndefined();
    // 残っているチャンクはある
    expect(result.context.chunks['sec-arch-001']).toBeDefined();

    expect(result.metadata?.iterations).toBe(3);
  });

  it('maxTurnsに到達したら終了する', async () => {
    // 常にツールを呼び続けるドライバー
    const driver = new TestDriver({
      responses: (prompt) => ({
        content: 'Still searching...',
        toolCalls: [
          { id: `tc-${Date.now()}`, name: 'search', arguments: { query: 'more' } },
        ],
      }),
    });

    const tools = createSearchTools(mockClient());
    const context: SearchAgentContext = { query: 'test', chunks: {} };

    const result = await toolAgentProcess(driver, searchAgentModule, context, {
      tools,
      maxTurns: 3,
    });

    expect(result.metadata?.iterations).toBe(3);
  });
});
