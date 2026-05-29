import * as fs from 'fs/promises';
import * as path from 'path';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

export function registerIndexPurgeTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;

  return server.registerTool(
    'index_purge',
    {
      description:
        'インデックスファイルを全削除します。壊れたインデックスを廃棄して再構築する場合に使います。',
      inputSchema: {},
    },
    async () => {
      if (systemState.state === 'NOT_CONFIGURED') {
        throw new Error(getStateErrorMessage(systemState.state, 'インデックス削除'));
      }

      if (!systemState.config) {
        throw new Error('設定が読み込めません。');
      }

      const indexPath = path.resolve(systemState.projectRoot, systemState.config.storage.indexPath);

      try {
        await fs.access(indexPath);
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'インデックスディレクトリが存在しません。削除の必要はありません。' }],
        };
      }

      await fs.rm(indexPath, { recursive: true, force: true });

      await context.refreshSystemState();

      return {
        content: [{
          type: 'text' as const,
          text: `インデックスを削除しました: ${indexPath}\n再構築するには index rebuild を実行してください。`,
        }],
      };
    }
  );
}
