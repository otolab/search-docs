/**
 * PIDファイル管理ユーティリティ（Server用）
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { PidFileContent } from '@search-docs/types';
import { getPidFilePath } from '@search-docs/types';

/**
 * プロセスが生きているか確認
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 は実際にシグナルを送らず、プロセスの存在確認のみ行う
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * PIDファイルを作成
 */
export async function writePidFile(content: PidFileContent): Promise<void> {
  const pidFilePath = getPidFilePath(content.projectRoot);

  // .search-docsディレクトリが存在しない場合は作成
  await fs.mkdir(path.dirname(pidFilePath), { recursive: true });

  // PIDファイル書き込み
  await fs.writeFile(pidFilePath, JSON.stringify(content, null, 2), {
    encoding: 'utf-8',
    mode: 0o600, // rw------- (所有者のみ読み書き可能)
  });
}

/**
 * PIDファイルを読み込み
 * @returns PIDファイルの内容。ファイルが存在しない場合はnull
 */
export async function readPidFile(projectRoot: string): Promise<PidFileContent | null> {
  const pidFilePath = getPidFilePath(projectRoot);

  try {
    const content = await fs.readFile(pidFilePath, 'utf-8');
    return JSON.parse(content) as PidFileContent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // ファイルが存在しない
    }
    throw error;
  }
}

/**
 * PIDファイルを削除
 */
export async function deletePidFile(projectRoot: string): Promise<void> {
  const pidFilePath = getPidFilePath(projectRoot);

  try {
    await fs.unlink(pidFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // ファイルが存在しない場合は無視
      return;
    }
    throw error;
  }
}
