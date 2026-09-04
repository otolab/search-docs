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
        'search-docsの設定ファイルを初期化します。ローカルプロジェクトの文書を検索対象にする場合に実行してください。',
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
        const initResult = await initConfig({
          port,
          force,
          cwd: systemState.projectRoot,
        });

        if (initResult === 'skipped') {
          return {
            content: [
              {
                type: 'text',
                text:
                  '⚠️ 設定ファイルは既に存在するため、初期化をスキップしました。\n' +
                  '既存の設定は変更されていません。\n\n' +
                  '上書きする場合は force: true を指定してください。\n',
              },
            ],
          };
        }

        // 設定が作成・上書きされた場合だけシステム状態を再検出する
        await refreshSystemState();

        let resultText = '✅ 設定ファイルの初期化が完了しました。\n\n';

        if (initResult === 'overwritten') {
          resultText += '既存の設定ファイルを上書きしました。\n\n';
        }

        resultText += '次のステップ:\n';
        resultText += '  1. 設定を調整（必要に応じて）: .search-docs/config.json を編集\n';
        resultText += '  2. Claude Codeを再接続してツールリストを更新\n';
        resultText += '  3. システム状態を確認: get_system_status\n\n';
        resultText += '設定項目の詳細はMCPリソース「設定リファレンス」を参照してください。\n';

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
