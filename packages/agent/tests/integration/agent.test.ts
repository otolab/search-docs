/**
 * インテグレーションテスト — context-1 実モデル使用
 *
 * ⚠️ 初回実行時にモデル（~11GB）が自動ダウンロードされます。
 *    ネットワーク環境とディスク空き容量に注意してください。
 * ⚠️ Apple Silicon (M1 Pro以上推奨) + Python 3.11以上が必要です。
 * ⚠️ 推論にはメモリ ~12GB を消費します。
 *
 * 実行: pnpm --filter @search-docs/agent test:integration
 *
 * 既知の制限:
 *   MlxDriver v0.11.0 は context-1 のネイティブtool call形式（<|call|>トークン）を
 *   未サポート（hasNativeToolSupport=false）。ツール定義はテキスト注入されるが、
 *   モデル出力からのtoolCallパースが機能しない。
 *   → MlxDriverのcontext-1対応が必要。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { MlxDriver } from '@modular-prompt/driver';
import { compile } from '@modular-prompt/core';
import { toolAgentProcess } from '@modular-prompt/process';
import { createSearchTools } from '../../src/tools.js';
import { searchAgentModule } from '../../src/prompt.js';
import { parseSearchAgentOutput } from '../../src/parse.js';
import type { SearchAgentContext } from '../../src/context.js';

/**
 * search-docs clientのモック
 * 実ドライバ（context-1）でエージェントループを回すが、
 * search-docsサーバは不要にするためclientはモック。
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

const MODEL = 'mlx-community/context-1-MLX-4bit';

describe('agent integration test (context-1)', () => {
  const driver = new MlxDriver({ model: MODEL });

  afterAll(async () => {
    await driver.close();
  });

  it('モデルが推論を実行できる（スモークテスト）', async () => {
    const context: SearchAgentContext = { query: 'アーキテクチャについて教えて', chunks: {} };
    const prompt = compile(searchAgentModule, context);

    const result = await driver.query(prompt, { maxTokens: 200 });

    expect(result.content).toBeTruthy();
    expect(result.finishReason).toBe('stop');
  });

  it('ツール定義付きで推論できる', async () => {
    const tools = createSearchTools(mockClient());
    const toolDefs = tools.map(t => t.definition);
    const context: SearchAgentContext = { query: 'アーキテクチャについて教えて', chunks: {} };
    const prompt = compile(searchAgentModule, context);

    const result = await driver.query(prompt, { tools: toolDefs, maxTokens: 200 });

    // context-1はツール定義を受け取って推論できる
    expect(result.content).toBeTruthy();
  });

  // MlxDriverがcontext-1のtool call形式に対応した後に有効化する
  it.skip('実モデルでツール呼び出し→最終出力の完全なフローが動く', async () => {
    const tools = createSearchTools(mockClient());
    const context: SearchAgentContext = { query: 'アーキテクチャについて教えて', chunks: {} };

    const result = await toolAgentProcess(driver, searchAgentModule, context, {
      tools,
      maxTurns: 5,
    });

    expect(Object.keys(result.context.chunks).length).toBeGreaterThan(0);

    const documents = parseSearchAgentOutput(result.output, result.context);
    expect(documents.length).toBeGreaterThanOrEqual(1);

    expect(result.metadata?.iterations).toBeGreaterThanOrEqual(2);
    expect(result.metadata?.toolCallLog?.length).toBeGreaterThanOrEqual(1);
  });

  it.skip('複数ターンの検索を実行できる', async () => {
    const tools = createSearchTools(mockClient());
    const context: SearchAgentContext = { query: 'データモデルとアーキテクチャの関係を説明して', chunks: {} };

    const result = await toolAgentProcess(driver, searchAgentModule, context, {
      tools,
      maxTurns: 5,
    });

    expect(Object.keys(result.context.chunks).length).toBeGreaterThan(0);
    expect(result.metadata?.iterations).toBeGreaterThanOrEqual(2);
  });
});
