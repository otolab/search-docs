import { z } from 'zod';
import { validateRebuildLayout } from '@search-docs/cli/utils/rebuild-layout';
import { assertPurgeSourcesOutsideIndex, clearIndexContents } from '@search-docs/server';
import { exclusivePurge } from '../maintenance/exclusive-purge.js';
import { getStateErrorMessage } from '../state.js';
import type { ToolRegistrationContext, RegisteredTool } from './types.js';

export function registerIndexPurgeTool(context: ToolRegistrationContext): RegisteredTool {
  const { server, systemState } = context;
  return server.registerTool('index_purge', {
    description: 'インデックスを削除します。対象が専用領域であり、他ホスト・旧版を含む全アクセスが停止し、処理中パスやマウントを変更しないことを確認してください。',
    inputSchema: { confirmIsolated: z.boolean().describe('上記の条件を利用者が確認した場合のみ true') },
  }, async ({ confirmIsolated }) => {
    if (systemState.state === 'NOT_CONFIGURED' || !systemState.config) throw new Error(getStateErrorMessage(systemState.state, 'インデックス削除'));
    if (!confirmIsolated) throw new Error('専用領域、全アクセスの停止、処理中のパス不変更を確認してください');
    if (!context.runMaintenance) throw new Error('安全な保守処理を利用できません');
    const config = systemState.config;
    const projectRoot = systemState.projectRoot;
    const validate = async () => {
      const layout = await validateRebuildLayout({ projectRoot, indexPath: config.storage.indexPath, documentsPath: config.storage.documentsPath });
      await assertPurgeSourcesOutsideIndex({ projectRoot, indexPath: layout.indexPath, sources: config.files.sources });
      return layout;
    };
    await validate();
    await context.runMaintenance(() => exclusivePurge({ confirmed: confirmIsolated, validate, remove: async layout => { await clearIndexContents(layout.indexPath); } }));
    return { content: [{ type: 'text' as const, text: 'インデックスを削除し、サービスを再開しました。' }] };
  });
}
