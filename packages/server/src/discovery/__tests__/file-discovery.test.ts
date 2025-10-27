import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FileDiscovery } from '../file-discovery.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

const TEST_DIR = path.join(tmpdir(), 'search-docs-discovery-test');

describe('FileDiscovery', () => {
  beforeAll(async () => {
    // テスト用ディレクトリとファイルを作成
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, 'docs'), { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, '.git'), { recursive: true });

    await fs.writeFile(path.join(TEST_DIR, 'README.md'), '# README');
    await fs.writeFile(path.join(TEST_DIR, 'docs', 'guide.md'), '# Guide');
    await fs.writeFile(path.join(TEST_DIR, 'docs', 'api.mdx'), '# API');
    await fs.writeFile(path.join(TEST_DIR, 'node_modules', 'lib.md'), '# Lib');
    await fs.writeFile(path.join(TEST_DIR, '.git', 'config'), 'config');

    // .gitignoreを作成
    await fs.writeFile(path.join(TEST_DIR, '.gitignore'), 'node_modules/\n.git/\n');
  });

  afterAll(async () => {
    // テスト用ディレクトリ削除
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('findFiles', () => {
    it('includeパターンでファイルを検索できる', async () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: [],
          ignoreGitignore: false,
        },
      });

      const files = await discovery.findFiles();
      expect(files).toContain('README.md');
      expect(files).toContain('docs/guide.md');
    });

    it('excludeパターンでファイルを除外できる', async () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: ['**/node_modules/**'],
          ignoreGitignore: false,
        },
      });

      const files = await discovery.findFiles();
      expect(files).toContain('README.md');
      expect(files).not.toContain('node_modules/lib.md');
    });

    it('.gitignoreを尊重できる', async () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: [],
          ignoreGitignore: true,
        },
      });

      const files = await discovery.findFiles();
      expect(files).toContain('README.md');
      expect(files).not.toContain('node_modules/lib.md');
    });

    it('複数の拡張子を検索できる', async () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md', '**/*.mdx'],
          exclude: ['**/node_modules/**'],
          ignoreGitignore: false,
        },
      });

      const files = await discovery.findFiles();
      expect(files).toContain('README.md');
      expect(files).toContain('docs/guide.md');
      expect(files).toContain('docs/api.mdx');
    });

    it('ネストしたディレクトリのファイルを検索できる', async () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: ['**/node_modules/**'],
          ignoreGitignore: false,
        },
      });

      const files = await discovery.findFiles();
      expect(files).toContain('docs/guide.md');
    });
  });

  describe('matchesPattern', () => {
    it('パターンにマッチするファイルを判定できる', () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: [],
          ignoreGitignore: false,
        },
      });

      expect(discovery.matchesPattern('README.md')).toBe(true);
      expect(discovery.matchesPattern('docs/guide.md')).toBe(true);
      expect(discovery.matchesPattern('test.txt')).toBe(false);
    });

    it('除外パターンを適用できる', () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: ['**/node_modules/**'],
          ignoreGitignore: false,
        },
      });

      expect(discovery.matchesPattern('README.md')).toBe(true);
      expect(discovery.matchesPattern('node_modules/lib.md')).toBe(false);
    });
  });

  describe('shouldIgnore', () => {
    it('除外すべきファイルを判定できる', () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: ['**/node_modules/**'],
          ignoreGitignore: false,
        },
      });

      expect(discovery.shouldIgnore('README.md')).toBe(false);
      expect(discovery.shouldIgnore('node_modules/lib.md')).toBe(true);
      expect(discovery.shouldIgnore('test.txt')).toBe(true);
    });

    it('.gitignoreを考慮できる', async () => {
      const discovery = new FileDiscovery({
        rootDir: TEST_DIR,
        config: {
          include: ['**/*.md'],
          exclude: [],
          ignoreGitignore: true,
        },
      });

      // .gitignoreを読み込むためにfindFilesを呼ぶ
      await discovery.findFiles();

      expect(discovery.shouldIgnore('README.md')).toBe(false);
      expect(discovery.shouldIgnore('node_modules/lib.md')).toBe(true);
    });
  });

  describe('存在しないディレクトリ', () => {
    it('存在しないディレクトリでも動作する', async () => {
      const discovery = new FileDiscovery({
        rootDir: path.join(TEST_DIR, 'nonexistent'),
        config: {
          include: ['**/*.md'],
          exclude: [],
          ignoreGitignore: false,
        },
      });

      const files = await discovery.findFiles();
      expect(files).toEqual([]);
    });
  });
});
