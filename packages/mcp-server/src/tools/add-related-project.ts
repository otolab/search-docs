/**
 * add_related_project ツール
 * 関連プロジェクトを一時的に追加する
 */

import * as path from 'path';
import { z } from 'zod';
import { ConfigLoader } from '@search-docs/types';
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
        '関連プロジェクトを一時的に追加します。追加されたプロジェクトはセッション中のみ有効で、設定ファイルには保存されません。指定ディレクトリに .search-docs.json が存在する必要があります。',
      inputSchema: {
        name: z.string().describe('プロジェクト名（一意の識別子）'),
        dir: z.string().describe('プロジェクトディレクトリ（相対パスまたは絶対パス）'),
        description: z.string().optional().describe('プロジェクトの説明'),
      },
    },
    async (args: { name: string; dir: string; description?: string }) => {
      const { name, dir, description } = args;

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
          `ディレクトリ "${resolvedDir}" に .search-docs.json が見つかりません。\n\n` +
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
      resultText += `\n⚠️  この追加はセッション中のみ有効です。永続化するには .search-docs.json を編集してください。\n\n`;
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
