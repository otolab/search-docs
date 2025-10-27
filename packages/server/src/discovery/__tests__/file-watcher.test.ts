import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileWatcher, type FileChangeEvent } from '../file-watcher.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('FileWatcher', () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    // 一時ディレクトリ作成
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-watcher-test-'));
  });

  afterEach(async () => {
    // watcher停止
    if (watcher) {
      await watcher.stop();
    }

    // 一時ディレクトリ削除
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('ファイル追加を検出できる', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    // ファイル作成
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    await wait(400); // デバウンス+処理待ち

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe('add');
    expect(events[0].path).toBe('test.md');
  });

  it('ファイル変更を検出できる', async () => {
    const events: FileChangeEvent[] = [];

    // 事前にファイル作成
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    // ファイル更新
    await fs.writeFile(testFile, '# Updated');

    await wait(400);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('change');
    expect(events[0].path).toBe('test.md');
  });

  it('ファイル削除を検出できる', async () => {
    const events: FileChangeEvent[] = [];

    // 事前にファイル作成
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    // ファイル削除
    await fs.unlink(testFile);

    await wait(400);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unlink');
    expect(events[0].path).toBe('test.md');
  });

  it('除外パターンのファイルは検出しない', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: ['**/node_modules/**'],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    // node_modules内にファイル作成
    const nodeModulesDir = path.join(tmpDir, 'node_modules');
    await fs.mkdir(nodeModulesDir);
    const testFile = path.join(nodeModulesDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    await wait(400);

    expect(events).toHaveLength(0);
  });

  it('デバウンスが機能する', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 200,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    const testFile = path.join(tmpDir, 'test.md');

    // 連続で書き込み
    await fs.writeFile(testFile, '# Test 1');
    await wait(50);
    await fs.writeFile(testFile, '# Test 2');
    await wait(50);
    await fs.writeFile(testFile, '# Test 3');

    await wait(500); // デバウンス待ち

    // デバウンスにより1回のイベントにまとまる
    expect(events.length).toBeLessThanOrEqual(2); // add + change
  });

  it('サブディレクトリのファイルも検出できる', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    // サブディレクトリ作成
    const subDir = path.join(tmpDir, 'docs');
    await fs.mkdir(subDir);

    const testFile = path.join(subDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    await wait(400);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('add');
    expect(events[0].path).toBe('docs/test.md');
  });

  it('停止後はイベントを検出しない', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        include: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ

    // 停止
    await watcher.stop();

    // ファイル作成（検出されないはず）
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    await wait(400);

    expect(events).toHaveLength(0);
  });
});
