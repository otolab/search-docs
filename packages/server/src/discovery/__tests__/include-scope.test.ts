import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { minimatch } from 'minimatch';
import {
  extractDirectoryPrefixes,
  resolveSubscribeRoots,
  buildWatchTargets,
  COMMON_IGNORES,
} from '../include-scope.js';

describe('extractDirectoryPrefixes', () => {
  it('globメタ文字の手前までを抽出する', () => {
    expect(extractDirectoryPrefixes(['docs/**/*.md'])).toEqual(['docs']);
  });

  it('先頭が ** の場合はルート（空文字列）', () => {
    expect(extractDirectoryPrefixes(['**/*.md'])).toEqual(['']);
  });

  it('深いパスのプレフィックスを抽出する', () => {
    expect(extractDirectoryPrefixes(['content/blog/**'])).toEqual([
      'content/blog',
    ]);
  });

  it('複数の独立したプレフィックスを返す', () => {
    const result = extractDirectoryPrefixes(['docs/**', 'blog/**']);
    expect(result).toEqual(expect.arrayContaining(['docs', 'blog']));
    expect(result).toHaveLength(2);
  });

  it('包含関係を解決する（親に集約）', () => {
    expect(
      extractDirectoryPrefixes(['systems/**', 'systems/docs/**'])
    ).toEqual(['systems']);
  });

  it('ルートパターンが含まれると全て集約される', () => {
    expect(
      extractDirectoryPrefixes(['docs/**', '**/*.md', 'blog/**'])
    ).toEqual(['']);
  });

  it('ファイル名パターンはディレクトリから除外される', () => {
    expect(extractDirectoryPrefixes(['README.md'])).toEqual(['']);
  });

  it('複雑なモノレポパターン', () => {
    const result = extractDirectoryPrefixes([
      'systems/**/packages/**/docs/**',
      'systems/*',
      'systems/docs/**',
    ]);
    expect(result).toEqual(['systems']);
  });

  it('重複パターンは排除される', () => {
    expect(
      extractDirectoryPrefixes(['docs/**/*.md', 'docs/**'])
    ).toEqual(['docs']);
  });

  it('空配列はルートを返す', () => {
    expect(extractDirectoryPrefixes([])).toEqual(['']);
  });

  it('packages配下の複数パス', () => {
    const result = extractDirectoryPrefixes([
      'packages/*/docs/**',
      'docs/**',
    ]);
    expect(result).toEqual(expect.arrayContaining(['packages', 'docs']));
    expect(result).toHaveLength(2);
  });
});

describe('resolveSubscribeRoots', () => {
  const rootDir = '/project';

  it('空プレフィックスはrootDir自体を返す', () => {
    expect(resolveSubscribeRoots(rootDir, [''])).toEqual(['/project']);
  });

  it('プレフィックスをrootDirに結合する', () => {
    expect(resolveSubscribeRoots(rootDir, ['docs'])).toEqual([
      path.join('/project', 'docs'),
    ]);
  });

  it('複数プレフィックスを解決する', () => {
    expect(resolveSubscribeRoots(rootDir, ['docs', 'blog'])).toEqual([
      path.join('/project', 'docs'),
      path.join('/project', 'blog'),
    ]);
  });
});

/*
 * buildWatchTargets — 仕様テスト
 *
 * FileWatcherの監視スコープは2層の協調で制御される:
 *
 *   Layer 1: subscribeルート（buildWatchTargetsが決定）
 *     includeパターンの静的プレフィックスで@parcel/watcherのsubscribe先を限定する。
 *     docs/** も docs/* も同じ "docs/" をsubscribeする。
 *     スコープ外のディレクトリは最初からinotify走査の対象にならない。
 *
 *   Layer 2: shouldProcessFile（FileWatcherクラスが実行）
 *     includeパターンの詳細マッチ + .md拡張子チェック。
 *     docs/** は docs/sub/file.md を通すが、docs/* は弾く。
 *
 *   ignorePatterns:
 *     COMMON_IGNORES + files.exclude を @parcel/watcher に渡す。
 *     subscribeルート内部の不要サブツリーを枝刈りする。
 */
describe('buildWatchTargets', () => {
  const rootDir = '/project';

  const makeConfig = (
    include: string[],
    exclude: string[] = []
  ) => ({
    include,
    exclude,
    ignoreGitignore: false,
    maxFileSize: 10 * 1024 * 1024,
  });

  // --- A. subscribeルートの決定 ---

  describe('subscribeルートの決定', () => {
    it('特定ディレクトリパターン → そのディレクトリをsubscribe', () => {
      const { subscribeRoots } = buildWatchTargets(
        rootDir,
        makeConfig(['docs/**/*.md'])
      );
      expect(subscribeRoots).toEqual([path.join(rootDir, 'docs')]);
    });

    it('独立した複数パターン → 複数のsubscribe', () => {
      const { subscribeRoots } = buildWatchTargets(
        rootDir,
        makeConfig(['docs/**', 'blog/**'])
      );
      expect(subscribeRoots).toHaveLength(2);
      expect(subscribeRoots).toEqual(
        expect.arrayContaining([
          path.join(rootDir, 'docs'),
          path.join(rootDir, 'blog'),
        ])
      );
    });

    it('ルートパターン(**/*.md) → プロジェクトルート全体をsubscribe', () => {
      const { subscribeRoots } = buildWatchTargets(
        rootDir,
        makeConfig(['**/*.md'])
      );
      expect(subscribeRoots).toEqual([rootDir]);
    });

    it('包含関係のあるパターン → 親プレフィックスに集約', () => {
      const { subscribeRoots } = buildWatchTargets(
        rootDir,
        makeConfig([
          'systems/**/packages/**/docs/**',
          'systems/*',
          'systems/docs/**',
        ])
      );
      expect(subscribeRoots).toEqual([path.join(rootDir, 'systems')]);
    });
  });

  // --- B. docs/** と docs/* の2層協調 ---

  describe('docs/** と docs/* — subscribeルートは同一、shouldProcessFileで差が出る', () => {
    // subscribeルートは「パターンが要求する最大範囲」を監視する。
    // docs/** も docs/* もglobメタ文字の手前は "docs" なので、
    // @parcel/watcher には docs/ ディレクトリ全体をsubscribeする。
    // 深い階層のファイルを通すか弾くかは shouldProcessFile の責任。

    it('docs/** と docs/* は同じsubscribeルートを生成する', () => {
      const recursive = buildWatchTargets(rootDir, makeConfig(['docs/**']));
      const shallow = buildWatchTargets(rootDir, makeConfig(['docs/*']));

      expect(recursive.subscribeRoots).toEqual(shallow.subscribeRoots);
      expect(recursive.subscribeRoots).toEqual([
        path.join(rootDir, 'docs'),
      ]);
    });

    // shouldProcessFile はFileWatcherのprivateメソッドだが、
    // 核心ロジックはminimatchなので、ここで同等のチェックを直接テストする。

    it('docs/** はサブディレクトリのファイルにマッチする', () => {
      expect(minimatch('docs/sub/file.md', 'docs/**')).toBe(true);
      expect(minimatch('docs/a/b/c/file.md', 'docs/**')).toBe(true);
    });

    it('docs/* はサブディレクトリのファイルにマッチしない', () => {
      expect(minimatch('docs/sub/file.md', 'docs/*')).toBe(false);
      expect(minimatch('docs/file.md', 'docs/*')).toBe(true);
    });

    it('docs/**/*.md は再帰的に.mdにマッチする', () => {
      expect(minimatch('docs/guide.md', 'docs/**/*.md')).toBe(true);
      expect(minimatch('docs/sub/guide.md', 'docs/**/*.md')).toBe(true);
      expect(minimatch('docs/sub/guide.txt', 'docs/**/*.md')).toBe(false);
    });
  });

  // --- C. ignoreパターンの構成 ---

  describe('ignoreパターンの構成', () => {
    it('exclude空 → COMMON_IGNORESのみ', () => {
      const { ignorePatterns } = buildWatchTargets(
        rootDir,
        makeConfig(['**/*.md'], [])
      );
      expect(ignorePatterns).toEqual([...COMMON_IGNORES]);
    });

    it('excludeパターン → COMMON_IGNORES + ユーザー設定', () => {
      const { ignorePatterns } = buildWatchTargets(
        rootDir,
        makeConfig(['**/*.md'], ['**/drafts/**'])
      );
      expect(ignorePatterns).toContain('**/drafts/**');
      for (const common of COMMON_IGNORES) {
        expect(ignorePatterns).toContain(common);
      }
    });

    it('COMMON_IGNORESにはパフォーマンス上重要なパターンが含まれる', () => {
      // inotify走査で最も大きなサブツリーを枝刈りするパターン
      expect(COMMON_IGNORES).toContain('**/node_modules/**');
      expect(COMMON_IGNORES).toContain('**/.git/**');
      expect(COMMON_IGNORES).toContain('**/dist/**');
      expect(COMMON_IGNORES).toContain('**/.search-docs/**');
    });
  });

  // --- D. 結合検証 ---

  describe('subscribeルート + ignoreパターンの結合', () => {
    it('includeでスコープ限定 + excludeで内部を枝刈り', () => {
      const { subscribeRoots, ignorePatterns } = buildWatchTargets(
        rootDir,
        makeConfig(['docs/**'], ['**/drafts/**'])
      );

      // subscribeルートはdocs/のみ
      expect(subscribeRoots).toEqual([path.join(rootDir, 'docs')]);

      // ignoreにdraftsとcommonIgnoresが含まれる
      expect(ignorePatterns).toContain('**/drafts/**');
      expect(ignorePatterns).toContain('**/node_modules/**');
    });

    it('モノレポ設定: 複数パターン + 複数exclude', () => {
      const { subscribeRoots, ignorePatterns } = buildWatchTargets(
        rootDir,
        makeConfig(
          ['docs/**', 'packages/*/docs/**'],
          ['**/node_modules/**', '**/dist/**', '**/src/**']
        )
      );

      expect(subscribeRoots).toHaveLength(2);
      expect(subscribeRoots).toEqual(
        expect.arrayContaining([
          path.join(rootDir, 'docs'),
          path.join(rootDir, 'packages'),
        ])
      );

      expect(ignorePatterns).toContain('**/src/**');
      expect(ignorePatterns).toContain('**/node_modules/**');
    });

    it('デフォルト設定(include: ["**/*.md"]) → ルート全体subscribe', () => {
      const { subscribeRoots, ignorePatterns } = buildWatchTargets(
        rootDir,
        makeConfig(
          ['**/*.md'],
          ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
        )
      );

      expect(subscribeRoots).toEqual([rootDir]);
      expect(ignorePatterns).toContain('**/node_modules/**');
      expect(ignorePatterns).toContain('**/.git/**');
    });
  });
});
