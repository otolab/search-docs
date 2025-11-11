/**
 * サーバ制御ツール
 * server_start, server_stop
 */

import { z } from 'zod';
import { startServer } from '@search-docs/cli/commands/server/start';
import { stopServer } from '@search-docs/cli/commands/server/stop';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * server_start ツールを登録
 */
export function registerServerStartTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState, refreshSystemState } = context;

  return server.registerTool(
    'server_start',
    {
      description:
        'search-docsサーバを起動します。設定ファイルが作成済みであることが必要です。デフォルトではバックグラウンドで起動します。',
      inputSchema: {
        foreground: z
          .boolean()
          .optional()
          .describe('フォアグラウンド起動（デフォルト: false、バックグラウンド起動）'),
      },
    },
    async (args: { foreground?: boolean }) => {
      // 状態チェック
      if (systemState.state === 'NOT_CONFIGURED') {
        throw new Error(getStateErrorMessage(systemState.state, 'サーバの起動'));
      }

      if (systemState.state === 'RUNNING') {
        return {
          content: [
            {
              type: 'text',
              text: 'サーバは既に起動しています。\n\nサーバ情報を確認するには get_system_status を使用してください。',
            },
          ],
        };
      }

      const { foreground = false } = args;

      try {
        // CLIのstartServer関数を呼び出し
        // startServer()内でヘルスチェックを行い、起動完了を待機する
        await startServer({
          config: systemState.configPath,
          foreground,
        });

        // システム状態を再検出
        await refreshSystemState();

        let resultText = '✅ サーバを起動しました。\n\n';

        if (foreground) {
          resultText += 'フォアグラウンドモードで起動しています。\n';
          resultText += '終了するには Ctrl+C を押してください。\n\n';
        } else {
          resultText += 'バックグラウンドモードで起動しました。\n\n';
        }

        resultText += '📌 重要: 検索系ツール（search, get_document, index_status）が利用可能になりました。\n';
        resultText += '   Claude Codeを再接続すると表示されます。\n';
        resultText += '   （Claude Codeは現時点でMCP通知に未対応のため、reconnectが必要です）\n\n';
        resultText += '次のステップ:\n';
        resultText += '  1. **Claude Codeを再接続してツールリストを更新**\n';
        resultText += '  2. システム状態を確認: get_system_status\n';
        resultText += '  3. インデックス状態を確認: index_status\n';
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
        throw new Error(`サーバの起動に失敗しました: ${(error as Error).message}`);
      }
    }
  );
}

/**
 * server_stop ツールを登録
 */
export function registerServerStopTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState, refreshSystemState } = context;

  return server.registerTool(
    'server_stop',
    {
      description: 'search-docsサーバを停止します。起動中のサーバを安全に終了します。',
      inputSchema: {},
    },
    async () => {
      // 状態チェック
      if (systemState.state === 'NOT_CONFIGURED') {
        throw new Error(getStateErrorMessage(systemState.state, 'サーバの停止'));
      }

      if (systemState.state === 'CONFIGURED_SERVER_DOWN') {
        return {
          content: [
            {
              type: 'text',
              text: 'サーバは既に停止しています。\n\nサーバを起動するには server_start を使用してください。',
            },
          ],
        };
      }

      try {
        // CLIのstopServer関数を呼び出し
        // systemState.projectRootをcwdとして明示的に渡す
        const configToUse = systemState.configPath ||
          (systemState.projectRoot ? `${systemState.projectRoot}/.search-docs.json` : undefined);

        await stopServer({
          config: configToUse,
          cwd: systemState.projectRoot,
        });

        // システム状態を再検出
        await refreshSystemState();

        let resultText = '✅ サーバを停止しました。\n\n';
        resultText += '📌 注意: 検索系ツール（search, get_document, index_status）が利用不可になりました。\n';
        resultText += '   Claude Codeを再接続すると、ツールリストが更新されます。\n';
        resultText += '   （Claude Codeは現時点でMCP通知に未対応のため、reconnectが必要です）\n\n';
        resultText += '次のステップ:\n';
        resultText += '  - サーバを再起動: server_start\n';

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      } catch (error) {
        throw new Error(`サーバの停止に失敗しました: ${(error as Error).message}`);
      }
    }
  );
}
