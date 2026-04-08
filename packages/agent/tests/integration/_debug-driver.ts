/**
 * ツールをテキスト注入で渡して、モデルが <|call|> を出力するか確認
 * hasNativeToolSupport=false の状態を再現するため、getCapabilities()を呼ばずにqueryする
 */
import { MlxDriver } from '@modular-prompt/driver';
import { compile } from '@modular-prompt/core';
import { searchAgentModule } from '../../src/prompt.js';
import { createSearchTools } from '../../src/tools.js';
import type { SearchAgentContext } from '../../src/context.js';

const MODEL = 'mlx-community/context-1-MLX-4bit';

async function main() {
  const driver = new MlxDriver({ model: MODEL });

  try {
    const tools = createSearchTools({
      search: async () => ({ results: [], total: 0, took: 0 }),
      getDocument: async () => ({ document: null, section: null }),
      getOutline: async () => ({ items: [] }),
    } as any);
    const toolDefs = tools.map(t => t.definition);

    const context: SearchAgentContext = { query: 'アーキテクチャについて教えて', chunks: {} };
    const prompt = compile(searchAgentModule, context);

    // getCapabilities() を呼ばない → hasNativeToolSupport=false
    // → tools はテキスト注入 → stop token 未設定 → <|call|> が出力に残るはず
    console.log('=== テキスト注入モード (native=false) ===');
    const r = await driver.query(prompt, { tools: toolDefs, maxTokens: 500 });
    console.log('finishReason:', r.finishReason);
    console.log('toolCalls:', JSON.stringify(r.toolCalls));
    console.log('\n--- raw content ---');
    console.log(r.content);
    console.log('--- end ---');
  } finally {
    await driver.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
