import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

/** 文書キーは全コンポーネントで同じプロジェクト相対表現を使う。 */
export function assertDocumentKey(key: string): void {
  if (!key || path.posix.isAbsolute(key) || path.win32.isAbsolute(key) || key.includes('\\') ||
      key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`安全な文書パスではありません: ${key}`);
  }
}

/** source / exclude の境界を静的に確認できないパターンは拒否する。 */
export function assertRelativePattern(pattern: string): void {
  if (!pattern || path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || pattern.includes('\\') ||
      pattern.split('/').includes('..') || /[{}!()]/.test(pattern)) {
    throw new Error(`安全な相対 glob ではありません: ${pattern}`);
  }
}

/** 存在する経路に symlink がないことを確認する。欠落した部分は操作側で扱う。 */
export async function assertSourcePath(root: string, key: string, requireParent = false): Promise<void> {
  assertDocumentKey(key);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  const parts = key.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`source にシンボリックリンクがあります: ${key}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (requireParent && index < parts.length - 1) throw new Error(`source の親を確認できません: ${key}`);
        return;
      }
      throw error;
    }
  }
}
