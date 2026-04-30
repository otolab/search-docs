/**
 * init ツール
 * search-docsの設定ファイルを初期化する
 */

import { z } from 'zod';
import { initConfig } from '@search-docs/cli/commands/config/init';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * init ツールを登録
 */
export function registerInitTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState, refreshSystemState } = context;

  return server.registerTool(
    'init',
    {
      description:
        'search-docsの設定ファイルを初期化します。プロジェクトで初めてsearch-docsを使用する際に実行してください。主要な設定項目の説明と次のステップが返されます。',
      inputSchema: {
        port: z
          .number()
          .optional()
          .describe('サーバポート番号（省略時はランダムなポート番号が割り当てられます）'),
        force: z
          .boolean()
          .optional()
          .describe('既存設定を上書き（デフォルト: false）'),
      },
    },
    async (args: { port?: number; force?: boolean }) => {
      const { port, force } = args;

      try {
        // CLIのinitConfig関数を呼び出し
        await initConfig({
          port,
          force,
          cwd: systemState.projectRoot,
        });

        // システム状態を再検出してツールリストを更新
        await refreshSystemState();

        let resultText = '✅ 設定ファイルの初期化が完了しました。\n\n';

        if (force) {
          resultText += '既存の設定ファイルを上書きしました。\n\n';
        }

        resultText += '📝 設定ファイルの重要な項目:\n\n';
        resultText += '**files.include**: インデックス対象ファイルのパターン\n';
        resultText += '  - デフォルト: ["**/*.md", "docs/**/*.txt"]\n';
        resultText += '  - プロジェクトに応じてパターンを調整してください\n\n';
        resultText += '**files.exclude**: 除外するファイルパターン\n';
        resultText += '  - デフォルト: node_modules, .git, dist, buildを除外\n';
        resultText += '  - 必要に応じて追加してください\n\n';
        resultText += '**indexing.maxDepth**: セクション分割の最大深度（0-3）\n';
        resultText += '  - 0: 文書全体のみ\n';
        resultText += '  - 1: 章レベルまで分割\n';
        resultText += '  - 2: 節レベルまで分割\n';
        resultText += '  - 3: 項レベルまで分割（デフォルト）\n\n';
        resultText += '**indexing.maxTokensPerSection**: セクションの最大トークン数\n';
        resultText += '  - デフォルト: 2000トークン\n';
        resultText += '  - 大きくすると粗い分割、小さくすると細かい分割になります\n\n';
        resultText += '次のステップ:\n';
        resultText += '  1. 設定を調整（必要に応じて）: .search-docs/config.json を編集\n';
        resultText += '  2. **Claude Codeを再接続してツールリストを更新**\n';
        resultText += '  3. システム状態を確認: get_system_status\n';
        resultText += '  4. 文書を検索: search\n';

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`設定ファイルの初期化に失敗しました: ${(error as Error).message}`);
      }
    }
  );
}
