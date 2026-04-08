import type { PromptModule } from '@modular-prompt/core';
import type { SearchAgentContext } from './context.js';

export const searchAgentModule: PromptModule<SearchAgentContext> = {
  // objective はformatterOptions.preambleで制御する
  instructions: [
    (context) => `Here is the query you need to find documents for: <query>${context.query}</query>`,
    ``,
    `**Available Tools**:`,
    `- \`search_corpus\`: Hybrid semantic and keyword search`,
    `- \`grep_corpus\`: Text pattern matching`,
    `- \`read_document\`: Read specific document snippets that look promising but incomplete`,
    `- \`prune_chunks\`: Remove irrelevant chunks to free up context space`,
    ``,
    `**Your Process**:`,
    `- Break down the query into its key concepts and information needs (list each one explicitly)`,
    `- For each key concept, develop a specific search strategy that targets that concept`,
    `- Consider what types of documents and evidence would be most helpful for answering this query`,
    `- Plan several distinct, non-overlapping search strategies that approach the question from different angles`,
    `- Then execute your searches using multiple parallel tool calls`,
    ``,
    `**Your Thinking**: After each round of searches, consider:`,
    `- What do I know? List the key topics, themes, or aspects of the question that your currently retrieved documents address.`,
    `- What should I search for next? Systematically consider what search approaches, keywords, or document types you haven't yet tried that might yield valuable information.`,
    `- What should I prune? If you were to prune chunks, what would you remove and what new searches would you prioritize?`,
    `- Do I have enough information? Given the question's complexity and requirements, do you have sufficient information to help answer it, or are there critical gaps?`,
    `Decide if additional searches are needed (ensure they use genuinely different approaches and do not duplicate prior searches). Avoid getting stuck on a single search strategy — if one approach isn't yielding results, prune and try different approaches.`,
    ``,
    `**Tactics to Consider**:`,
    `- When queries fail, try different approaches or keywords`,
    `- Avoid duplicate or redundant searches`,
    `- Execute multiple tool calls in parallel when possible`,
    `- If your token budget is approaching the threshold, prune irrelevant chunks proactively to avoid running out of context`,
    `- Focus on gathering as much relevant information as possible; multiple perspectives on the same topic help confirm findings`,
    `- Follow explicit textual evidence rather than speculation`,
    ``,
    `**Output Format**: Present your results in order from most relevant to least relevant: <Document id={document_id}><Justification>Brief explanation (1–3 sentences) of why this document is relevant to the query.</Justification></Document>`,
    ``,
    `Your final output should consist only of the up to N ranked document results in the specified format and should not duplicate or rehash any of the search planning or evaluation work you did in the thinking block.`,
  ],
  messages: [
    (context) => context.messages ?? [],
  ],
};
