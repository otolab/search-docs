/**
 * search-docs agent コマンド
 *
 * 検索エージェントを実行し、クエリに関連するドキュメントを収集する。
 */
import { SearchDocsClient } from '@search-docs/client';
import { runSearchAgent } from '@search-docs/agent';
import type { FormatterOptions } from '@modular-prompt/driver';
import { resolveServerUrl } from '../utils/server-url.js';
import { createDriver, type DriverType } from '../utils/driver-factory.js';

/**
 * 検索エージェント用のフォーマッタ設定
 * preamble でモデルの役割を指示する（PromptModule.objective の代わり）
 */
const searchAgentFormatterOptions: FormatterOptions = {
  preamble: 'You are a retrieval subagent in a multi-agent system. Your specific role is to identify and retrieve the most relevant documents from a large corpus to help another agent answer questions. You do NOT answer questions yourself — you only find and retrieve relevant documents.',
  sectionDescriptions: {
    instructions: '',
    data: '',
    output: '',
  },
};

export interface AgentCommandOptions {
  driver: string;
  model?: string;
  maxTurns?: string;
  format?: 'text' | 'json';
  server?: string;
  config?: string;
}

export async function executeAgent(
  query: string,
  options: AgentCommandOptions,
): Promise<void> {
  const driverType = options.driver as DriverType;
  const maxTurns = options.maxTurns ? parseInt(options.maxTurns, 10) : 10;

  // 1. サーバURL解決
  const baseUrl = await resolveServerUrl({
    server: options.server,
    config: options.config,
  });

  // 2. クライアント作成・ヘルスチェック
  const client = new SearchDocsClient({ baseUrl });
  try {
    await client.healthCheck();
  } catch {
    console.error(`エラー: search-docs サーバに接続できません (${baseUrl})`);
    console.error('  → search-docs server start で起動してください');
    process.exit(1);
  }

  // 3. ドライバ生成
  const driver = await createDriver({
    type: driverType,
    model: options.model,
    formatterOptions: searchAgentFormatterOptions,
  });

  try {
    console.error(`検索エージェント実行中... (driver=${driverType}, maxTurns=${maxTurns})`);

    // 4. エージェント実行
    const result = await runSearchAgent(
      { driver, client },
      { query, maxTurns },
    );

    // 5. ログ出力
    if (result.logEntries && result.logEntries.length > 0) {
      console.error('\n--- log entries ---');
      for (const entry of result.logEntries) {
        console.error(entry.formatted);
      }
      console.error('--- end log ---\n');
    }

    // 6. 結果出力
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printTextResult(query, result);
    }
  } finally {
    // 6. ドライバ close（MlxDriverはPythonプロセスを持つ）
    if ('close' in driver && typeof driver.close === 'function') {
      await driver.close();
    }
  }
}

function printTextResult(
  query: string,
  result: Awaited<ReturnType<typeof runSearchAgent>>,
): void {
  console.log(`\nクエリ: ${query}`);
  console.log(`ターン数: ${result.turns}`);

  if (result.documents.length === 0) {
    console.log('\n関連ドキュメントが見つかりませんでした。');
    console.log('\n--- raw output ---');
    console.log(result.rawOutput);
    return;
  }

  console.log(`\n取得ドキュメント: ${result.documents.length}件`);
  console.log('─'.repeat(60));

  for (const doc of result.documents) {
    console.log(`\n[${doc.sectionId}] ${doc.heading}`);
    console.log(`  パス: ${doc.documentPath}`);
    console.log(`  根拠: ${doc.justification}`);
    console.log(`  内容: ${doc.content.slice(0, 200)}${doc.content.length > 200 ? '...' : ''}`);
  }

  if (result.usage) {
    console.log(`\nトークン使用量: ${result.usage.totalTokens} (prompt: ${result.usage.promptTokens}, completion: ${result.usage.completionTokens})`);
  }
}
