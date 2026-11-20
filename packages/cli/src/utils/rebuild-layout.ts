import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';

/** 再構築時に扱う領域。呼び出し元は別途排他と再検証を行う。 */
export interface RebuildLayout {
  indexPath: string;
  documentsPath: string;
  managementPath: string;
}

export const MANUAL_RECOVERY_GUIDANCE = [
  '自動再構築できない配置です。インデックスを削除していません。',
  '手動で復旧する場合は、まず MCP・HTTP サーバーなど、この領域を使うすべてのプロセスを停止してください。',
  '設定ファイルの storage.indexPath をプロジェクトルートから解決し、シンボリックリンクやマウント先を含めて実際の削除対象を確認してください。',
  '対象がインデックス専用であり、元文書、文書コピー、他のプロジェクトのデータを含まないと確認できた場合に限り、必要に応じてバックアップしたうえで手動削除してください。',
  '確認できない場合は削除せず、管理者に相談してください。削除後はサーバーを起動し、索引化の完了とエラーを確認してください。',
].join('\n');

function fail(reason: string): never {
  throw new Error(`${reason}\n${MANUAL_RECOVERY_GUIDANCE}`);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function checkDirectory(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`ディレクトリではないか、シンボリックリンクです: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * 標準の兄弟配置を検査する。これは削除の許可ではない。
 * 他プロセスとの排他、別名のマウント、検査後のパス変更は呼び出し元で対処する。
 */
export async function validateRebuildLayout(options: {
  projectRoot: string;
  indexPath: string;
  documentsPath: string;
}): Promise<RebuildLayout> {
  try {
    const projectRoot = await realpath(options.projectRoot);
    const index = path.resolve(projectRoot, options.indexPath);
    const documents = path.resolve(projectRoot, options.documentsPath);
    if (path.basename(index) !== 'index' || path.basename(documents) !== 'documents' || path.dirname(index) !== path.dirname(documents)) {
      fail('storage.indexPath と storage.documentsPath が標準の兄弟配置ではありません。');
    }
    const parent = await realpath(path.dirname(index));
    const resolvedIndex = path.join(parent, 'index');
    const resolvedDocuments = path.join(parent, 'documents');
    const managementPath = path.join(parent, '.search-docs-maintenance');
    if (contains(resolvedIndex, projectRoot) || contains(resolvedIndex, resolvedDocuments) || contains(resolvedIndex, managementPath)) {
      fail('インデックスの削除対象がプロジェクトまたは別の保存領域と重なります。');
    }
    await access(parent, constants.R_OK | constants.W_OK | constants.X_OK);
    await checkDirectory(resolvedIndex);
    await checkDirectory(resolvedDocuments);
    await checkDirectory(managementPath);
    return { indexPath: resolvedIndex, documentsPath: resolvedDocuments, managementPath };
  } catch (error) {
    if (error instanceof Error && error.message.includes(MANUAL_RECOVERY_GUIDANCE)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`保存領域を確認できません: ${detail}`);
  }
}
