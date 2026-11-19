import { getStateErrorMessage } from '../state.js';
import type { RegisteredTool, ToolRegistrationContext } from './types.js';

export function registerDiagnoseDuplicatesTool(context: ToolRegistrationContext): RegisteredTool {
  return context.server.registerTool('diagnose_duplicates', {
    description: '索引の固定時点を読み取り、同じ文書の完全に一致するセクション木の重複候補を検出します。修復は行いません。',
    inputSchema: {},
  }, async () => {
    if (context.systemState.state !== 'RUNNING') {
      throw new Error(getStateErrorMessage(context.systemState.state, '重複候補の検査'));
    }
    const db = context.getDbEngine?.();
    if (!db) throw new Error('索引を検査する DB が利用できません。');
    let result: Awaited<ReturnType<typeof db.diagnoseDuplicateSections>>;
    try {
      result = await db.diagnoseDuplicateSections();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: 'text' as const, text: `検査は失敗し、不完全です。重複の有無は判定できません: ${message}` }] };
    }
    const lines = [
      `索引バージョン: ${result.version}（検査時点のスナップショット。現在の状態とは異なる場合があります）`,
      `読み取り: ${result.rowsRead} 行、${result.bytesRead} バイト`,
    ];
    if (!result.complete) {
      lines.push('検査は上限に達したため不完全です。重複の有無は判定できません。');
    } else {
      lines.push(`重複候補: ${result.candidates.length} 件（省略 ${result.omitted} 件）、判定不能: ${result.ambiguous} グループ`);
      for (const candidate of result.candidates) {
        lines.push(`- ${candidate.path}: root ID ${candidate.rootIds.join(', ')}（計 ${candidate.rootCount} 件）`);
      }
      lines.push('完全な木の一致を候補として示します。部分重複や旧形式は検出できない場合があります。');
    }
    lines.push('索引の変更や修復は行っていません。');
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}
