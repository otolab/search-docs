import * as path from 'path';
import * as fs from 'fs/promises';
import type { FilesConfig } from '@search-docs/types';

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

export interface WatchTarget {
  root: string;              // subscribe する絶対パス
  depth: 'deep' | 'shallow';
  ignorePatterns: string[];  // globパターン（COMMON_IGNORES + exclude）
  ignorePaths: string[];     // 絶対パス（shallow用サブディレクトリ）
}

export interface PatternAnalysis {
  type: 'deep' | 'shallow';
  staticPrefix: string;  // globメタ文字の手前までのパス
  pattern: string;        // 正規化後のパターン
}

const GLOB_META_CHARS = new Set(['*', '?', '{', '[']);

function hasGlobMeta(segment: string): boolean {
  return Array.from(segment).some(char => GLOB_META_CHARS.has(char));
}

export function analyzePattern(pattern: string): PatternAnalysis {
  // ./プレフィックスを除去して正規化
  const normalized = pattern.replace(/^\.\//g, '');

  // **の有無でdeep/shallowを判定
  const type = normalized.includes('**') ? 'deep' : 'shallow';

  // セグメント分割
  const segments = normalized.split('/');

  // 最後のセグメントが拡張子付きファイル名かチェック
  const lastSegment = segments[segments.length - 1];
  const isFileExtension = lastSegment.includes('.') && !hasGlobMeta(lastSegment);

  // staticPrefixを抽出（globメタ文字を含むセグメントの手前まで）
  const prefixSegments: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // 最後のセグメントが拡張子付きファイル名なら除外
    if (i === segments.length - 1 && isFileExtension) {
      break;
    }

    // globメタ文字を含むセグメントが見つかったら終了
    if (hasGlobMeta(segment)) {
      break;
    }

    prefixSegments.push(segment);
  }

  const staticPrefix = prefixSegments.join('/');

  return {
    type,
    staticPrefix,
    pattern: normalized,
  };
}

export interface FileSystemOps {
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean }[]>;
  isDirectory(dir: string): Promise<boolean>;
}

const defaultFsOps: FileSystemOps = {
  async readdir(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  async isDirectory(dir: string) {
    try {
      return (await fs.stat(dir)).isDirectory();
    } catch {
      return false;
    }
  },
};

export async function buildWatchTargets(
  rootDir: string,
  filesConfig: FilesConfig,
  fsOps?: FileSystemOps,
): Promise<WatchTarget[]> {
  const ops = fsOps ?? defaultFsOps;

  // パターン解析
  const analyses = filesConfig.sources.map(pattern => analyzePattern(pattern));

  // deep/shallowに分類
  const deepAnalyses = analyses.filter(a => a.type === 'deep');
  const shallowAnalyses = analyses.filter(a => a.type === 'shallow');

  // globプレフィックスを展開してdeep rootsを構築
  const deepRoots = new Set<string>();

  for (const analysis of deepAnalyses) {
    const resolvedPaths = await resolveSubscribeRoots(rootDir, analysis, ops);
    resolvedPaths.forEach(p => deepRoots.add(p));
  }

  // 包含関係の解決（親deepが子deepを包含）
  const dedupedDeepRoots = deduplicateByInclusion(Array.from(deepRoots));

  // shallow rootsを構築
  const shallowRoots = new Set<string>();

  for (const analysis of shallowAnalyses) {
    const resolvedPaths = await resolveSubscribeRoots(rootDir, analysis, ops);
    resolvedPaths.forEach(p => shallowRoots.add(p));
  }

  // 共通のignorePatterns
  const ignorePatterns = [...COMMON_IGNORES, ...filesConfig.exclude];

  // WatchTargetを構築
  const targets: WatchTarget[] = [];

  // deep targets
  for (const root of dedupedDeepRoots) {
    if (!await ops.isDirectory(root)) continue;

    targets.push({
      root,
      depth: 'deep',
      ignorePatterns,
      ignorePaths: [],
    });
  }

  // shallow targets（deep に包含されるものは除外）
  for (const root of shallowRoots) {
    if (!await ops.isDirectory(root)) continue;

    const coveredByDeep = dedupedDeepRoots.some(
      deepRoot => root === deepRoot || root.startsWith(deepRoot + '/'),
    );
    if (coveredByDeep) continue;

    const entries = await ops.readdir(root);
    const ignorePaths = entries
      .filter(e => e.isDirectory)
      .map(e => path.join(root, e.name));

    targets.push({
      root,
      depth: 'shallow',
      ignorePatterns,
      ignorePaths,
    });
  }

  return targets;
}

async function resolveSubscribeRoots(
  rootDir: string,
  analysis: PatternAnalysis,
  ops: FileSystemOps,
): Promise<string[]> {
  const { staticPrefix, pattern, type } = analysis;

  if (!staticPrefix) {
    return [rootDir];
  }

  const prefixPath = path.join(rootDir, staticPrefix);

  if (type === 'shallow') {
    return [prefixPath];
  }

  // deep パターン: ** の手前までの中間パスセグメントを解決
  const afterPrefix = pattern.slice(staticPrefix.length).replace(/^\//, '');
  const doubleStarIdx = afterPrefix.indexOf('**');

  if (doubleStarIdx <= 0) {
    return [prefixPath];
  }

  // 中間セグメントを取得（systems/*/docs/** → ['*', 'docs']）
  const middlePart = afterPrefix.slice(0, doubleStarIdx).replace(/\/$/, '');
  const middleSegments = middlePart.split('/');

  return walkToResolve(prefixPath, middleSegments, ops);
}

async function walkToResolve(
  basePath: string,
  segments: string[],
  ops: FileSystemOps,
): Promise<string[]> {
  if (segments.length === 0) {
    return [basePath];
  }

  const [current, ...rest] = segments;

  if (current === '*') {
    const entries = await ops.readdir(basePath);
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        results.push(...await walkToResolve(path.join(basePath, entry.name), rest, ops));
      }
    }
    return results;
  }

  return walkToResolve(path.join(basePath, current), rest, ops);
}

function deduplicateByInclusion(paths: string[]): string[] {
  const sorted = paths.slice().sort();
  const result: string[] = [];

  for (const current of sorted) {
    const isIncluded = result.some(existing => {
      // currentがexistingの子孫かチェック
      return current.startsWith(existing + '/') || current === existing;
    });

    if (!isIncluded) {
      result.push(current);
    }
  }

  return result;
}
