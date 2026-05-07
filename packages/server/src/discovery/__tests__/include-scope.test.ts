import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  analyzePattern,
  buildWatchTargets,
  COMMON_IGNORES,
  type FileSystemOps,
  type PatternAnalysis,
  type WatchTarget,
} from '../include-scope.js';
import type { FilesConfig } from '@search-docs/types';

const ROOT = '/project';

function makeConfig(
  sources: string[],
  exclude: string[] = [],
): FilesConfig {
  return {
    sources,
    exclude,
    ignoreGitignore: true,
    maxFileSize: 10 * 1024 * 1024,
  };
}

/**
 * テスト用のFileSystemOpsモック
 *
 * dirTree で仮想ディレクトリ構造を定義する。
 * キー: ディレクトリの絶対パス
 * 値: エントリの配列（name + isDirectory）
 */
function mockFsOps(
  dirTree: Record<string, { name: string; isDirectory: boolean }[]>,
): FileSystemOps {
  return {
    readdir(dir: string) {
      return dirTree[dir] ?? [];
    },
    isDirectory(dir: string) {
      // dirTreeのキーとして存在するか、
      // 親ディレクトリのエントリに含まれているかで判定
      if (dirTree[dir] !== undefined) return true;
      const parent = path.dirname(dir);
      const name = path.basename(dir);
      const entries = dirTree[parent];
      if (!entries) return false;
      return entries.some(e => e.name === name && e.isDirectory);
    },
  };
}

function dir(name: string) {
  return { name, isDirectory: true };
}

function file(name: string) {
  return { name, isDirectory: false };
}

// ─── analyzePattern ───────────────────────────────────

describe('analyzePattern', () => {
  it('** を含むパターンは deep', () => {
    expect(analyzePattern('docs/**')).toEqual<PatternAnalysis>({
      type: 'deep',
      staticPrefix: 'docs',
      pattern: 'docs/**',
    });
  });

  it('** を含まないパターンは shallow', () => {
    expect(analyzePattern('docs/*')).toEqual<PatternAnalysis>({
      type: 'shallow',
      staticPrefix: 'docs',
      pattern: 'docs/*',
    });
  });

  it('ルートレベルの * は shallow', () => {
    expect(analyzePattern('*.md')).toEqual<PatternAnalysis>({
      type: 'shallow',
      staticPrefix: '',
      pattern: '*.md',
    });
  });

  it('ファイル名パターンは shallow、プレフィックスは空', () => {
    expect(analyzePattern('README.md')).toEqual<PatternAnalysis>({
      type: 'shallow',
      staticPrefix: '',
      pattern: 'README.md',
    });
  });

  it('./ プレフィックスを正規化', () => {
    expect(analyzePattern('./docs/**')).toEqual<PatternAnalysis>({
      type: 'deep',
      staticPrefix: 'docs',
      pattern: 'docs/**',
    });
  });

  it('深いパスのプレフィックス抽出', () => {
    expect(analyzePattern('content/blog/**')).toEqual<PatternAnalysis>({
      type: 'deep',
      staticPrefix: 'content/blog',
      pattern: 'content/blog/**',
    });
  });

  it('中間 glob のプレフィックス抽出', () => {
    expect(analyzePattern('systems/*/docs/**')).toEqual<PatternAnalysis>({
      type: 'deep',
      staticPrefix: 'systems',
      pattern: 'systems/*/docs/**',
    });
  });

  it('先頭が ** の場合はプレフィックス空', () => {
    expect(analyzePattern('**/*.md')).toEqual<PatternAnalysis>({
      type: 'deep',
      staticPrefix: '',
      pattern: '**/*.md',
    });
  });

  it('サブディレクトリ指定のファイルパターン', () => {
    expect(analyzePattern('docs/guides/README.md')).toEqual<PatternAnalysis>({
      type: 'shallow',
      staticPrefix: 'docs/guides',
      pattern: 'docs/guides/README.md',
    });
  });
});

// ─── buildWatchTargets ────────────────────────────────
/*
 * buildWatchTargets — 仕様テスト
 *
 * FileWatcherの監視スコープは3層構造で制御される:
 *
 *   Layer 0: ツリーウォーク（buildWatchTargets）
 *     sourcesパターンを解析し、deep/shallow subscriptionを決定。
 *     shallow rootには全サブディレクトリをignorePathsに追加。
 *
 *   Layer 1: @parcel/watcher subscription
 *     deep root: 再帰監視（COMMON_IGNORES + exclude のみ）
 *     shallow root: 直下ファイルのみ（全サブディレクトリを ignore）
 *
 *   Layer 2: shouldProcessFile（FileWatcherクラスが実行）
 *     sourcesパターンの詳細マッチ + .md拡張子チェック。
 */

describe('buildWatchTargets', () => {
  // A. subscribeルートの決定

  describe('subscribe ルートの決定', () => {
    it('単一 deep パターン → そのディレクトリを deep subscribe', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('src')],
        [`${ROOT}/docs`]: [file('README.md')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['docs/**']), fs);

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        root: `${ROOT}/docs`,
        depth: 'deep',
      });
    });

    it('独立した複数 deep パターン → 複数 deep subscribe', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('blog')],
        [`${ROOT}/docs`]: [],
        [`${ROOT}/blog`]: [],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['docs/**', 'blog/**']),
        fs,
      );

      const deepTargets = targets.filter(t => t.depth === 'deep');
      expect(deepTargets).toHaveLength(2);
      expect(deepTargets.map(t => t.root).sort()).toEqual([
        `${ROOT}/blog`,
        `${ROOT}/docs`,
      ]);
    });

    it('ルートパターン（**/*.md）→ ルート全体を deep subscribe', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('src')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['**/*.md']), fs);

      const deepTargets = targets.filter(t => t.depth === 'deep');
      expect(deepTargets).toHaveLength(1);
      expect(deepTargets[0].root).toBe(ROOT);
    });

    it('包含関係のある deep パターン → 親に集約', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs')],
        [`${ROOT}/docs`]: [dir('api')],
        [`${ROOT}/docs/api`]: [],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['docs/**', 'docs/api/**']),
        fs,
      );

      const deepTargets = targets.filter(t => t.depth === 'deep');
      expect(deepTargets).toHaveLength(1);
      expect(deepTargets[0].root).toBe(`${ROOT}/docs`);
    });
  });

  // B. shallow/deep の区別

  describe('shallow / deep の区別', () => {
    /*
     * docs/** と docs/* はどちらも docs/ をsubscribeするが、
     * docs/** は deep（再帰監視）、docs/* は shallow（直下のみ）。
     * shallowの実現方法: 全サブディレクトリを ignorePaths に追加。
     */

    it('docs/** は deep subscription を生成', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs')],
        [`${ROOT}/docs`]: [dir('sub'), file('README.md')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['docs/**']), fs);

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        root: `${ROOT}/docs`,
        depth: 'deep',
        ignorePaths: [],
      });
    });

    it('docs/* は shallow subscription を生成（サブディレクトリを ignorePaths に追加）', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs')],
        [`${ROOT}/docs`]: [dir('sub'), dir('guides'), file('README.md')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['docs/*']), fs);

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        root: `${ROOT}/docs`,
        depth: 'shallow',
      });
      expect(targets[0].ignorePaths).toEqual(
        expect.arrayContaining([
          `${ROOT}/docs/sub`,
          `${ROOT}/docs/guides`,
        ]),
      );
    });

    it('deep + shallow 混在 → 両方のターゲットを生成', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('blog'), file('README.md')],
        [`${ROOT}/docs`]: [dir('sub')],
        [`${ROOT}/blog`]: [dir('2024')],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['docs/**', 'blog/*', '*.md']),
        fs,
      );

      const deep = targets.filter(t => t.depth === 'deep');
      const shallow = targets.filter(t => t.depth === 'shallow');

      expect(deep).toHaveLength(1);
      expect(deep[0].root).toBe(`${ROOT}/docs`);

      // *.md と blog/* はどちらも shallow
      expect(shallow.map(t => t.root).sort()).toEqual([
        ROOT,
        `${ROOT}/blog`,
      ]);
    });
  });

  // C. glob プレフィックスの解決

  describe('glob プレフィックスの解決', () => {
    // systems/{*}/docs/{**} のように中間に glob を含むパターンは、
    // ディレクトリを走査して実パスを解決する。

    it('systems/*/docs/** → 各サブプロジェクトの docs/ を deep subscribe', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('systems')],
        [`${ROOT}/systems`]: [dir('app-a'), dir('app-b'), file('README.md')],
        [`${ROOT}/systems/app-a`]: [dir('docs'), dir('src')],
        [`${ROOT}/systems/app-a/docs`]: [file('guide.md')],
        [`${ROOT}/systems/app-b`]: [dir('docs')],
        [`${ROOT}/systems/app-b/docs`]: [],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['systems/*/docs/**']),
        fs,
      );

      const deepTargets = targets.filter(t => t.depth === 'deep');
      expect(deepTargets.map(t => t.root).sort()).toEqual([
        `${ROOT}/systems/app-a/docs`,
        `${ROOT}/systems/app-b/docs`,
      ]);
    });

    it('存在しないディレクトリはスキップ', () => {
      const fs = mockFsOps({
        [ROOT]: [],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['nonexistent/**']),
        fs,
      );

      expect(targets).toHaveLength(0);
    });
  });

  // D. ignore パターンの構成

  describe('ignore パターンの構成', () => {
    it('exclude 空 → COMMON_IGNORES のみ', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs')],
        [`${ROOT}/docs`]: [],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['docs/**']), fs);

      expect(targets[0].ignorePatterns).toEqual([...COMMON_IGNORES]);
    });

    it('exclude 指定 → COMMON_IGNORES + ユーザー設定', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs')],
        [`${ROOT}/docs`]: [],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['docs/**'], ['**/drafts/**']),
        fs,
      );

      expect(targets[0].ignorePatterns).toEqual([
        ...COMMON_IGNORES,
        '**/drafts/**',
      ]);
    });

    it('COMMON_IGNORES にはパフォーマンス上重要なパターンが含まれる', () => {
      expect(COMMON_IGNORES).toContain('**/node_modules/**');
      expect(COMMON_IGNORES).toContain('**/.git/**');
      expect(COMMON_IGNORES).toContain('**/.search-docs/**');
    });
  });

  // E. shallow の ignorePaths

  describe('shallow の ignorePaths', () => {
    it('shallow root の全サブディレクトリを ignorePaths に含める', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('blog'), dir('src'), dir('tools'), file('README.md')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['*.md']), fs);

      const shallowTarget = targets.find(t => t.depth === 'shallow');
      expect(shallowTarget).toBeDefined();
      expect(shallowTarget!.ignorePaths).toEqual(
        expect.arrayContaining([
          `${ROOT}/docs`,
          `${ROOT}/blog`,
          `${ROOT}/src`,
          `${ROOT}/tools`,
        ]),
      );
      // ファイルは含まれない
      expect(shallowTarget!.ignorePaths).not.toContain(`${ROOT}/README.md`);
    });

    it('deep root は ignorePaths を持たない', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs')],
        [`${ROOT}/docs`]: [dir('sub'), dir('guides')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['docs/**']), fs);

      const deepTarget = targets.find(t => t.depth === 'deep');
      expect(deepTarget!.ignorePaths).toEqual([]);
    });
  });

  // F. 結合検証

  describe('結合検証', () => {
    it('Issue #99 の代表例: docs/** + blog/* + *.md', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('blog'), dir('src'), dir('tools'), file('README.md')],
        [`${ROOT}/docs`]: [dir('sub'), file('guide.md')],
        [`${ROOT}/blog`]: [dir('2024'), file('post.md')],
      });

      const targets = buildWatchTargets(
        ROOT,
        makeConfig(['docs/**', 'blog/*', '*.md'], ['src/**']),
        fs,
      );

      // deep: docs
      const deep = targets.filter(t => t.depth === 'deep');
      expect(deep).toHaveLength(1);
      expect(deep[0].root).toBe(`${ROOT}/docs`);
      expect(deep[0].ignorePatterns).toEqual([...COMMON_IGNORES, 'src/**']);
      expect(deep[0].ignorePaths).toEqual([]);

      // shallow: root (*.md) + blog (blog/*)
      const shallow = targets.filter(t => t.depth === 'shallow');
      expect(shallow.map(t => t.root).sort()).toEqual([
        ROOT,
        `${ROOT}/blog`,
      ]);

      // root shallow: 全サブディレクトリを ignore
      const rootShallow = shallow.find(t => t.root === ROOT)!;
      expect(rootShallow.ignorePaths).toEqual(
        expect.arrayContaining([
          `${ROOT}/docs`,
          `${ROOT}/blog`,
          `${ROOT}/src`,
          `${ROOT}/tools`,
        ]),
      );

      // blog shallow: サブディレクトリを ignore
      const blogShallow = shallow.find(t => t.root === `${ROOT}/blog`)!;
      expect(blogShallow.ignorePaths).toEqual([`${ROOT}/blog/2024`]);
    });

    it('デフォルト設定（**/*.md）→ ルート全体を deep subscribe', () => {
      const fs = mockFsOps({
        [ROOT]: [dir('docs'), dir('src')],
      });

      const targets = buildWatchTargets(ROOT, makeConfig(['**/*.md']), fs);

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        root: ROOT,
        depth: 'deep',
      });
    });
  });
});
