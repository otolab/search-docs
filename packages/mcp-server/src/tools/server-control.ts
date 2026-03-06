/**
 * サーバ制御ツール
 * server_start, server_stop
 */

import { z } from 'zod';
import { startServer } from '@search-docs/cli/commands/server/start';
import { stopServer } from '@search-docs/cli/commands/server/stop';
import { ConfigLoader } from '@search-docs/types';
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
        'search-docsサーバを起動します。検索・文書取得を行う前に必要です。起動結果と次のステップが返されます。',
      inputSchema: {
        foreground: z
          .boolean()
          .optional()
          .describe('フォアグラウンド起動（デフォルト: false、バックグラウンド起動）'),
        project: z
          .string()
          .optional()
          .describe('関連プロジェクト名（未指定時はメインプロジェクト）'),
      },
    },
    async (args: { foreground?: boolean; project?: string }) => {
      const { foreground = false, project } = args;

      if (project) {
        // 関連プロジェクトのサーバを起動
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects,
          systemState.configPath
        );
        if (!allRelated[project]) {
          const availableProjects = Object.keys(allRelated).length > 0
            ? Object.keys(allRelated).join(', ')
            : '(なし)';
          throw new Error(
            `関連プロジェクト "${project}" が見つかりません。\n\n` +
            `利用可能なプロジェクト: ${availableProjects}\n\n` +
            '設定ファイルの relatedProjects セクションを確認するか、add_related_project で追加してください。'
          );
        }

        // 既に起動しているか確認
        const existingClient = await context.serverManager.getServer(project);
        if (existingClient) {
          return {
            content: [
              {
                type: 'text',
                text: `関連プロジェクト "${project}" のサーバは既に起動しています。`,
              },
            ],
          };
        }

        // 設定を解決（allRelatedのdirは絶対パスに解決済み）
        const projectDir = allRelated[project].dir;
        const relatedProjectConfig = await ConfigLoader.resolve({
          cwd: projectDir,
          traverseUp: false,
          requireConfig: false,
        });

        if (!relatedProjectConfig.config) {
          throw new Error(`関連プロジェクト "${project}" の設定を解決できませんでした。`);
        }

        try {
          await context.serverManager.getOrStartServer(
            project,
            relatedProjectConfig.projectRoot,
            relatedProjectConfig.config.server.port,
            relatedProjectConfig.configPath || undefined
          );

          return {
            content: [
              {
                type: 'text',
                text: `✅ 関連プロジェクト "${project}" のサーバを起動しました。\n\n` +
                  '次のステップ:\n' +
                  `  - 文書を検索: search(query: "...", project: "${project}")\n` +
                  `  - サーバを停止: server_stop(project: "${project}")`,
              },
            ],
          };
        } catch (error) {
          throw new Error(`関連プロジェクト "${project}" のサーバ起動に失敗しました: ${(error as Error).message}`);
        }
      }

      // 状態チェック
      if (systemState.state === 'NOT_CONFIGURED') {
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects,
          systemState.configPath
        );
        const relatedNames = Object.keys(allRelated);
        throw new Error(getStateErrorMessage(systemState.state, 'サーバの起動', relatedNames));
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

        resultText += '次のステップ:\n';
        resultText += '  1. システム状態を確認: get_system_status\n';
        resultText += '  2. インデックス状態を確認: index_status\n';
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
      description:
        'search-docsサーバを停止します。サーバのリソースを解放したいときに使用します。',
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe('関連プロジェクト名（未指定時はメインプロジェクト）'),
      },
    },
    async (args: { project?: string }) => {
      const { project } = args;

      if (project) {
        // 関連プロジェクトのサーバを停止
        try {
          await context.serverManager.stopRelatedServer(project);

          return {
            content: [
              {
                type: 'text',
                text: `✅ 関連プロジェクト "${project}" のサーバを停止しました。\n\n` +
                  '次のステップ:\n' +
                  `  - サーバを再起動: server_start(project: "${project}")`,
              },
            ],
          };
        } catch (error) {
          throw new Error(`関連プロジェクト "${project}" のサーバ停止に失敗しました: ${(error as Error).message}`);
        }
      }

      // 状態チェック
      if (systemState.state === 'NOT_CONFIGURED') {
        const allRelated = context.serverManager.getAllRelatedProjects(
          systemState.config?.relatedProjects,
          systemState.configPath
        );
        const relatedNames = Object.keys(allRelated);
        throw new Error(getStateErrorMessage(systemState.state, 'サーバの停止', relatedNames));
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
