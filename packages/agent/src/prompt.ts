import type { PromptModule } from '@modular-prompt/core';
import type { SearchAgentContext } from './context.js';

/**
 * 検索エージェント用 PromptModule
 *
 * Context-1の訓練時プロンプトに準拠した指示を提供。
 * context.chunksの内容を動的にプロンプトに反映する。
 */
export const searchAgentModule: PromptModule<SearchAgentContext> = {
  objective: [
    `You are a retrieval subagent. Your role is to identify and retrieve the most relevant document sections from a corpus to help answer questions.
You do NOT answer questions yourself — you only find and retrieve relevant documents.`,
  ],

  methodology: [
    `Steps:
1. Break down the query into its key concepts and information needs (list each one explicitly)
2. For each key concept, develop a specific search strategy
3. Plan several distinct, non-overlapping search approaches
4. Use get_outline to understand document structure, get_document for full details
5. Prune irrelevant chunks to keep context focused
6. When sufficient information is gathered, output relevant documents with justification

After each round of searches, consider:
- What do I know? List the key findings so far.
- What should I search for next? What approaches haven't been tried.
- Should I prune any chunks that turned out to be irrelevant?`,
  ],

  inputs: [
    (context) => `Query: ${context.query}`,
  ],

  chunks: [
    (context) => {
      const entries = Object.values(context.chunks);
      if (entries.length === 0) return null;
      const lines = entries.map(c =>
        `[${c.id}] ${c.documentPath} — ${c.heading} (${c.tokenCount ?? '?'} tokens)\n${c.content.slice(0, 200)}...`
      );
      return `Retrieved chunks (${entries.length}):\n\n${lines.join('\n\n')}`;
    },
  ],

  schema: [
    `Output format — for each relevant document:
<Document id={sectionId}>
  <Justification>Why this document is relevant (1-3 sentences)</Justification>
</Document>`,
  ],
};
