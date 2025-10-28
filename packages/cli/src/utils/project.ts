/**
 * プロジェクトルート管理ユーティリティ
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * プロジェクトルートを正規化
 * - 絶対パスに変換
 * - シンボリックリンクを解決
 * - 末尾のスラッシュを削除
 */
export async function normalizeProjectRoot(root: string): Promise<string> {
  // 絶対パスに変換
  const absolutePath = path.resolve(root);

  try {
    // シンボリックリンクを解決
    const realPath = await fs.realpath(absolutePath);

    // 末尾のスラッシュを削除
    return realPath.replace(/\/$/, '');
  } catch (_error) {
    // ディレクトリが存在しない場合は絶対パスをそのまま返す
    return absolutePath.replace(/\/$/, '');
  }
}

/**
 * 設定ファイルパスからプロジェクトルートを取得
 */
export async function getProjectRootFromConfig(
  configPath: string
): Promise<string> {
  // 設定ファイルの親ディレクトリ
  const configDir = path.dirname(path.resolve(configPath));

  return await normalizeProjectRoot(configDir);
}

/**
 * プロジェクトルートを検索
 * 1. 設定ファイルのproject.rootフィールド
 * 2. 設定ファイルの親ディレクトリ
 * 3. カレントワーキングディレクトリ
 */
export interface FindProjectRootOptions {
  configPath?: string;
  cwd?: string;
}

export async function findProjectRoot(
  options: FindProjectRootOptions = {}
): Promise<string> {
  const cwd = options.cwd || process.cwd();

  // 設定ファイルが指定されている場合
  if (options.configPath) {
    const configPath = path.resolve(cwd, options.configPath);

    try {
      // 設定ファイルを読み込んで project.root を確認
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent) as {
        project?: { root?: string };
      };

      if (config.project?.root) {
        // 設定ファイルで明示的に指定されている場合
        const configDir = path.dirname(configPath);
        const projectRoot = path.resolve(configDir, config.project.root);
        return await normalizeProjectRoot(projectRoot);
      }

      // 設定ファイルの親ディレクトリをプロジェクトルートとする
      return await getProjectRootFromConfig(configPath);
    } catch (_error) {
      // 設定ファイルが読み込めない場合は親ディレクトリを使用
      return await getProjectRootFromConfig(configPath);
    }
  }

  // カレントワーキングディレクトリをプロジェクトルートとする
  return await normalizeProjectRoot(cwd);
}

/**
 * デフォルトの設定ファイルパスを検索
 * プロジェクトルート内の以下のファイルを順に探す：
 * 1. .search-docs.json
 * 2. search-docs.json
 */
export async function findDefaultConfigPath(
  projectRoot: string
): Promise<string | null> {
  const candidates = ['.search-docs.json', 'search-docs.json'];

  for (const candidate of candidates) {
    const configPath = path.join(projectRoot, candidate);

    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // ファイルが存在しない、次を試す
      continue;
    }
  }

  return null;
}

/**
 * 設定ファイルパスを解決
 * 1. 明示的に指定されたパス
 * 2. プロジェクトルート内のデフォルトファイル
 * 3. なければデフォルトパス（.search-docs.json）を返す
 */
export async function resolveConfigPath(
  projectRoot: string,
  specifiedPath?: string
): Promise<string> {
  // 明示的に指定されている場合
  if (specifiedPath) {
    return path.resolve(projectRoot, specifiedPath);
  }

  // デフォルトファイルを検索
  const defaultPath = await findDefaultConfigPath(projectRoot);

  if (defaultPath) {
    return defaultPath;
  }

  // デフォルトパスを返す（存在しなくてもこのパスを返す）
  return path.join(projectRoot, '.search-docs.json');
}
