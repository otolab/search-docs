/**
 * init ツール
 * search-docsの設定ファイルを初期化する
 */

import { z } from 'zod';
import { initConfig } from '@search-docs/cli/commands/config/init';
import type { ToolRegistrationContext } from './types.js';

/**
 * init ツールを登録
 */
export function registerInitTool(context: ToolRegistrationContext): void {
  const { server, systemState } = context;

  server.registerTool(
    'init',
    {
      description:
        'search-docsの設定ファイルを初期化します。プロジェクトで初めてsearch-docsを使用する場合に実行してください。既存の設定ファイルがある場合、forceオプションを指定しない限り上書きしません。',
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

        let resultText = '✅ 設定ファイルの初期化が完了しました。\n\n';

        if (force) {
          resultText += '既存の設定ファイルを上書きしました。\n\n';
        }

        resultText += '次のステップ:\n';
        resultText += '  1. サーバを起動: server_start\n';
        resultText += '  2. システム状態を確認: get_system_status\n';
        resultText += '  3. 文書を検索: search\n';

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
