/**
 * add_related_project ツール
 * 関連プロジェクトを一時的に追加する
 */

import * as path from 'path';
import { z } from 'zod';
import { ConfigLoader } from '@search-docs/types';
import { SearchDocsClient } from '@search-docs/client';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

/**
 * add_related_project ツールを登録
 */
export function registerAddRelatedProjectTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState, serverManager } = context;

  return server.registerTool(
    'add_related_project',
    {
      description:
        '関連プロジェクトを一時的に追加します。追加されたプロジェクトはセッション中のみ有効で、設定ファイルには保存されません。\n' +
        'dirまたはurlのいずれか一方を指定します。\n' +
        '- dir: 指定ディレクトリに .search-docs.json が存在する必要があります（.search-docs/config.json も自動検出）\n' +
        '- url: 起動済みのsearch-docsサーバに接続します。対象プロジェクトで `search-docs server start` を実行してからURLを指定してください（Docker環境ではlocalhostを自動でhost.docker.internalに補正します）',
      inputSchema: {
        name: z.string().describe('プロジェクト名（一意の識別子）'),
        dir: z.string().optional().describe('プロジェクトディレクトリ（相対パスまたは絶対パス）'),
        url: z.string().optional().describe('起動済みサーバのURL（例: http://localhost:<port>）'),
        description: z.string().optional().describe('プロジェクトの説明'),
      },
    },
    async (args: { name: string; dir?: string; url?: string; description?: string }) => {
      const { name, dir, url, description } = args;

      // dir と url の排他チェック
      if (!dir && !url) {
        throw new Error('dir または url のいずれか一方を指定してください。');
      }
      if (dir && url) {
        throw new Error('dir と url は同時に指定できません。どちらか一方のみを指定してください。');
      }

      // 名前の重複チェック（設定ファイル + 一時追加分）
      const allRelated = serverManager.getAllRelatedProjects(
        systemState.config?.relatedProjects,
        systemState.configPath
      );
      if (allRelated[name]) {
        throw new Error(
          `関連プロジェクト "${name}" は既に登録されています。`
        );
      }

      // URL 指定時の処理
      if (url) {
        const { ServerManager } = await import('../server-manager.js');
        const resolvedUrl = ServerManager.resolveDockerUrl(url);
        const client = new SearchDocsClient({ baseUrl: resolvedUrl });
        try {
          await client.healthCheck();
        } catch (error) {
          throw new Error(
            `指定されたURLのサーバに接続できません: ${url}\n\n` +
            `エラー: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // 一時追加（URL形式）
        serverManager.addTemporaryRelatedProject(name, {
          url,
          description,
        });

        let resultText = `✅ 関連プロジェクト "${name}" を一時的に追加しました。\n\n`;
        resultText += `  URL: ${url}\n`;
        if (description) {
          resultText += `  説明: ${description}\n`;
        }
        resultText += `\n⚠️  この追加はセッション中のみ有効です。永続化するには設定ファイルを編集してください。\n\n`;
        resultText += '次のステップ:\n';
        resultText += `  - 検索を実行: search(query: "...", project: "${name}")\n`;
        resultText += `  - 一覧を確認: list_related_projects\n`;

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      }

      // dir 指定時の処理（既存のまま）
      if (!dir) {
        throw new Error('dir が指定されていません。');
      }

      // ディレクトリを解決（プロジェクトルートからの相対パス）
      const resolvedDir = path.resolve(systemState.projectRoot, dir);

      // .search-docs.json の存在確認
      const resolveResult = await ConfigLoader.resolve({
        cwd: resolvedDir,
        traverseUp: false,
        requireConfig: false,
      });

      if (!resolveResult.config) {
        throw new Error(
          `ディレクトリ "${resolvedDir}" に設定ファイルが見つかりません。\n\n` +
          '関連プロジェクトとして追加するには、対象ディレクトリで init を実行してください。'
        );
      }

      // 一時追加（絶対パスで保存）
      serverManager.addTemporaryRelatedProject(name, {
        dir: resolvedDir,
        description,
      });

      let resultText = `✅ 関連プロジェクト "${name}" を一時的に追加しました。\n\n`;
      resultText += `  ディレクトリ: ${resolvedDir}\n`;
      if (description) {
        resultText += `  説明: ${description}\n`;
      }
      resultText += `\n⚠️  この追加はセッション中のみ有効です。永続化するには設定ファイルを編集してください。\n\n`;
      resultText += '次のステップ:\n';
      resultText += `  - サーバを起動: server_start(project: "${name}")\n`;
      resultText += `  - 一覧を確認: list_related_projects\n`;

      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    }
  );
}
