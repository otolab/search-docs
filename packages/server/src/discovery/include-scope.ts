import * as path from 'path';
import type { FilesConfig } from '@search-docs/types';

const GLOB_METACHARACTERS = new Set(['*', '?', '{', '[']);

/**
 * @parcel/watcher の inotify初期走査で常に除外すべきディレクトリ群。
 * inotifyバックエンド(Linux)では subscribe() 時に全ディレクトリを再帰走査して
 * watchを設定するため、不要なディレクトリの除外がパフォーマンスに直結する。
 */
export const COMMON_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.pnpm-store/**',
  '**/.yarn/**',
  '**/.venv/**',
  '**/.uv/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.search-docs/**',
  '**/__pycache__/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
] as const;

export interface WatchTargets {
  subscribeRoots: string[];
  ignorePatterns: string[];
}

/**
 * FilesConfigからFileWatcherのsubscribeルートとignoreパターンを決定する。
 *
 * 2層の協調で監視スコープを制御する:
 *
 * Layer 1 — subscribeルート（粗いスコープ制限）:
 *   includeパターンの静的プレフィックスでsubscribe先を限定する。
 *   docs/** も docs/* も同じ "docs/" をsubscribeする。
 *   スコープ外のディレクトリは最初から走査されない。
 *
 * Layer 2 — shouldProcessFile（精密なフィルタ、この関数の範囲外）:
 *   includeパターンの詳細マッチ + .md拡張子チェック。
 *   docs/** は docs/sub/file.md を通すが、docs/* は弾く。
 *
 * ignorePatterns:
 *   COMMON_IGNORES（パフォーマンス最適化）+ files.exclude（ユーザー設定）。
 *   @parcel/watcher に渡され、subscribe先内部の不要サブツリーを枝刈りする。
 */
export function buildWatchTargets(
  rootDir: string,
  filesConfig: FilesConfig
): WatchTargets {
  const prefixes = extractDirectoryPrefixes(filesConfig.include);
  const subscribeRoots = resolveSubscribeRoots(rootDir, prefixes);

  const ignorePatterns: string[] = [
    ...COMMON_IGNORES,
    ...filesConfig.exclude,
  ];

  return { subscribeRoots, ignorePatterns };
}

/**
 * includeパターンからglobメタ文字の手前までの静的ディレクトリプレフィックスを抽出する。
 *
 * @example
 *   "docs/**\/*.md"                    → "docs"
 *   "systems/**\/packages/**\/docs/**" → "systems"
 *   "**\/*.md"                         → ""
 *   "README.md"                        → ""
 *   "content/blog/**"                  → "content/blog"
 */
function extractPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const staticSegments: string[] = [];

  for (const segment of segments) {
    if ([...segment].some((ch) => GLOB_METACHARACTERS.has(ch))) {
      break;
    }
    staticSegments.push(segment);
  }

  // ファイル名(拡張子付き)がある場合は除外してディレクトリのみにする
  if (staticSegments.length > 0) {
    const last = staticSegments[staticSegments.length - 1];
    if (last.includes('.')) {
      staticSegments.pop();
    }
  }

  return staticSegments.join('/');
}

/**
 * includeパターン配列からsubscribeすべきディレクトリプレフィックスを抽出する。
 *
 * 1. 各パターンから静的プレフィックスを抽出
 * 2. 重複排除
 * 3. 包含関係を解決（親が含まれていれば子は不要）
 *
 * 空文字列 "" はプロジェクトルート全体を意味する。
 * 結果に "" が含まれる場合、他の全てのプレフィックスは不要。
 */
export function extractDirectoryPrefixes(patterns: string[]): string[] {
  if (patterns.length === 0) {
    return [''];
  }

  const prefixes = patterns.map(extractPrefix);

  // 正規化: 末尾スラッシュ除去、パス区切り統一
  const normalized = prefixes.map((p) => p.replace(/\/+$/, ''));

  // 重複排除
  const unique = [...new Set(normalized)];

  // 空文字列（ルート）が含まれていれば、他は全て包含される
  if (unique.includes('')) {
    return [''];
  }

  // ソート（短い方が先 → 親が先に来る）
  unique.sort((a, b) => a.length - b.length);

  // 包含関係の解決: 親プレフィックスに包含される子を除去
  const result: string[] = [];
  for (const prefix of unique) {
    const isContained = result.some(
      (existing) =>
        prefix === existing || prefix.startsWith(existing + '/')
    );
    if (!isContained) {
      result.push(prefix);
    }
  }

  return result;
}

/**
 * プレフィックス配列をrootDir基準の絶対パスに解決する。
 * 空文字列はrootDir自体を返す。
 */
export function resolveSubscribeRoots(
  rootDir: string,
  prefixes: string[]
): string[] {
  return prefixes.map((prefix) =>
    prefix === '' ? rootDir : path.join(rootDir, prefix)
  );
}
