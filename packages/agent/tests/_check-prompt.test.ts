import { it } from 'vitest';
import { compile } from '@modular-prompt/core';
import { formatCompletionPrompt, formatPromptAsMessages } from '@modular-prompt/driver';
import { searchAgentModule } from '../src/prompt.js';
import type { SearchAgentContext } from '../src/context.js';

it('プロンプトの内容を確認', () => {
  const context: SearchAgentContext = {
    query: 'アーキテクチャについて教えて',
    chunks: {},
    messages: [],
  };

  const compiled = compile(searchAgentModule, context);

  console.log('=== CompiledPrompt sections ===');
  console.log('instructions:', compiled.instructions?.length ?? 0, 'elements');
  console.log('data:', compiled.data?.length ?? 0, 'elements');
  console.log('output:', compiled.output?.length ?? 0, 'elements');

  console.log('\n=== formatCompletionPrompt (no options) ===');
  console.log(formatCompletionPrompt(compiled, {}));

  console.log('\n=== formatCompletionPrompt (with preamble) ===');
  console.log(formatCompletionPrompt(compiled, {
    preamble: 'You are a retrieval subagent in a multi-agent system. Your specific role is to identify and retrieve the most relevant documents from a large corpus to help another agent answer questions. You do NOT answer questions yourself — you only find and retrieve relevant documents.',
  }));

  console.log('\n=== formatPromptAsMessages (preamble + sectionDescriptions) ===');
  const msgs = formatPromptAsMessages(compiled, {
    preamble: 'You are a retrieval subagent in a multi-agent system. Your specific role is to identify and retrieve the most relevant documents from a large corpus to help another agent answer questions. You do NOT answer questions yourself — you only find and retrieve relevant documents.',
    sectionDescriptions: {
      data: 'The following contains the conversation history including search results and user queries.',
      output: 'Present your final answer using <Document> tags for each relevant document found.',
    },
  });
  console.log(JSON.stringify(msgs, null, 2));
});
