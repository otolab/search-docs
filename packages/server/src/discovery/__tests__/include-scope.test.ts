import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { extractDirectoryPrefixes, resolveSubscribeRoots } from '../include-scope.js';

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
