import type { ToolAgentContext } from '@modular-prompt/process';

/**
 * 検索エージェントのコンテキスト
 * toolAgentProcess の TContext として使用
 */
export interface SearchAgentContext extends ToolAgentContext {
  /** 検索クエリ */
  query: string;
  /** 取得済みチャンクの蓄積。ツールハンドラが検索・読み込み結果を格納し、prune_chunksで削除する。 */
  chunks: Record<string, { id: string; documentPath: string; heading: string; content: string; score?: number }>;
}

/**
 * エージェントが出力する関連文書
 */
export interface RetrievedDocument {
  sectionId: string;
  documentPath: string;
  heading: string;
  content: string;
  justification: string;
}

/**
 * runSearchAgent の入力
 */
export interface SearchAgentInput {
  query: string;
  /** 追加コンテキスト */
  context?: string;
  /** 最大ターン数 (デフォルト: 10) */
  maxTurns?: number;
}

/**
 * runSearchAgent の出力
 */
export interface SearchAgentOutput {
  documents: RetrievedDocument[];
  /** モデルの最終出力テキスト */
  rawOutput: string;
  /** 実行ターン数 */
  turns: number;
  /** トークン使用量 */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** ワークフロー実行ログ */
  logEntries?: import('@modular-prompt/process').WorkflowResult<SearchAgentContext>['logEntries'];
}
