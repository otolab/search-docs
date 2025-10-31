/**
 * PIDファイル管理ユーティリティ
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * PIDファイルの内容
 */
export interface PidFileContent {
  // プロセス情報
  pid: number;
  startedAt: string; // ISO 8601形式

  // プロジェクト情報
  projectRoot: string;
  projectName: string;

  // サーバ設定
  host: string;
  port: number;
  configPath: string | null;

  // ログ情報（オプション）
  logPath?: string;

  // メタ情報
  version: string;
  nodeVersion: string;
}

/**
 * PIDファイルのパスを取得
 */
export function getPidFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.search-docs', 'server.pid');
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
export async function readPidFile(
  projectRoot: string
): Promise<PidFileContent | null> {
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

/**
 * PIDファイルが存在するか確認
 */
export async function pidFileExists(projectRoot: string): Promise<boolean> {
  const pidFilePath = getPidFilePath(projectRoot);

  try {
    await fs.access(pidFilePath);
    return true;
  } catch {
    return false;
  }
}
