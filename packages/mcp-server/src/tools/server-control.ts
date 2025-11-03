/**
 * サーバ制御ツール
 * server_start, server_stop
 */

import { z } from 'zod';
import { startServer } from '@search-docs/cli/commands/server/start';
import { stopServer } from '@search-docs/cli/commands/server/stop';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext } from './types.js';

/**
 * server_start ツールを登録
 */
export function registerServerStartTool(context: ToolRegistrationContext): void {
  const { server, systemState } = context;

  server.registerTool(
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
        await startServer({
          config: systemState.configPath,
          foreground,
        });

        let resultText = '✅ サーバを起動しました。\n\n';

        if (foreground) {
          resultText += 'フォアグラウンドモードで起動しています。\n';
          resultText += '終了するには Ctrl+C を押してください。\n\n';
        } else {
          resultText += 'バックグラウンドモードで起動しました。\n\n';
        }

        resultText += '次のステップ:\n';
        resultText += '  - システム状態を確認: get_system_status\n';
        resultText += '  - インデックス状態を確認: index_status\n';
        resultText += '  - 文書を検索: search\n';

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
export function registerServerStopTool(context: ToolRegistrationContext): void {
  const { server, systemState } = context;

  server.registerTool(
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
        await stopServer({
          config: systemState.configPath,
        });

        return {
          content: [
            {
              type: 'text',
              text: '✅ サーバを停止しました。\n\nサーバを再起動するには server_start を使用してください。',
            },
          ],
        };
      } catch (error) {
        throw new Error(`サーバの停止に失敗しました: ${(error as Error).message}`);
      }
    }
  );
}
