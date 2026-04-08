import type { AIDriver } from '@modular-prompt/driver';
import { toolAgentProcess } from '@modular-prompt/process';
import type { SearchDocsClient } from '@search-docs/client';
import type { SearchAgentContext, SearchAgentInput, SearchAgentOutput } from './context.js';
import { createSearchTools } from './tools.js';
import { searchAgentModule } from './prompt.js';
import { parseSearchAgentOutput } from './parse.js';

export interface RunSearchAgentOptions {
  driver: AIDriver;
  client: SearchDocsClient;
}

/**
 * 検索エージェントを実行する
 *
 * toolAgentProcess に search-docs 用のツール・プロンプト・コンテキストを渡して実行し、
 * 結果を SearchAgentOutput に変換して返す。
 */
export async function runSearchAgent(
  options: RunSearchAgentOptions,
  input: SearchAgentInput,
): Promise<SearchAgentOutput> {
  const { driver, client } = options;
  const tools = createSearchTools(client);

  const context: SearchAgentContext = {
    query: input.query,
    chunks: {},
    messages: [],
  };

  const result = await toolAgentProcess(
    driver,
    searchAgentModule,
    context,
    {
      tools,
      maxTurns: input.maxTurns ?? 10,
    },
  );

  const documents = parseSearchAgentOutput(result.output, result.context);

  return {
    documents,
    rawOutput: result.output,
    turns: result.metadata?.iterations ?? 0,
    usage: result.consumedUsage,
    logEntries: result.logEntries,
  };
}
