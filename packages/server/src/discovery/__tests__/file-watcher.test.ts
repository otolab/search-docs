import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  /**
   * イベントが来るまで待つ（最大タイムアウトあり）
   * @param events イベント配列
   * @param minCount 最小イベント数
   * @param timeoutMs タイムアウト時間（デフォルト: 2000ms）
   */
  const waitForEvents = async (
    events: FileChangeEvent[],
    minCount: number = 1,
    timeoutMs: number = 5000
  ): Promise<void> => {
    const startTime = Date.now();
    while (events.length < minCount && Date.now() - startTime < timeoutMs) {
      await wait(100);
    }
  };

  it('flushes a deletion received during debounce on normal stop', { timeout: 10000 }, async () => {
    const file = path.join(tmpDir, 'pending.md');
    await fs.writeFile(file, '# Before');
    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 1024 },
      watcherConfig: { enabled: true, debounceMs: 5000, awaitWriteFinishMs: 50 },
    });
    const events: FileChangeEvent[] = [];
    watcher.on('change', event => events.push(event));
    await watcher.start();
    await wait(300);
    await fs.unlink(file);
    const pending = watcher as unknown as { debounceTimers: Map<string, { type: string }> };
    await vi.waitFor(() => expect([...pending.debounceTimers.values()].some(event => event.type === 'unlink')).toBe(true));
    expect(events).toHaveLength(0);
    await watcher.stop();
    expect(events.some(event => event.type === 'unlink' && event.path === 'pending.md')).toBe(true);
  });

  it('cancels debounce timers before waiting for unsubscribe after ownership loss', async () => {
    vi.useFakeTimers();
    try {
      watcher = new FileWatcher({
        rootDir: tmpDir,
        filesConfig: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false, maxFileSize: 1024 },
        watcherConfig: { enabled: true, debounceMs: 100, awaitWriteFinishMs: 50 },
      });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const internal = watcher as unknown as {
        subscriptions: Array<{ unsubscribe: () => Promise<void> }>;
        handleFileEvent: (type: 'unlink', filePath: string) => void;
      };
      internal.subscriptions = [{ unsubscribe: () => gate }];
      const events: FileChangeEvent[] = [];
      watcher.on('change', event => events.push(event));
      internal.handleFileEvent('unlink', path.join(tmpDir, 'a.md'));
      const stopping = watcher.stop(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(events).toHaveLength(0);
      release();
      await stopping;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    '初期同期と監視の追加・変更で .gitignore 設定を揃える (ignoreGitignore=%s)',
    { timeout: 15000 },
    async (ignoreGitignore) => {
      const { FileDiscovery } = await import('../file-discovery.js');
      const config = {
        sources: ['**/*.md'], exclude: [], ignoreGitignore, maxFileSize: 10 * 1024 * 1024,
      };
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'private*.md\n');
      await fs.writeFile(path.join(tmpDir, 'private-existing.md'), '# Existing');
      const discovery = new FileDiscovery({ rootDir: tmpDir, config });
      expect((await discovery.findFiles()).includes('private-existing.md')).toBe(!ignoreGitignore);

      watcher = new FileWatcher({
        rootDir: tmpDir, filesConfig: config,
        watcherConfig: { enabled: true, debounceMs: 100, awaitWriteFinishMs: 50 },
      });
      const events: FileChangeEvent[] = [];
      watcher.on('change', (event: FileChangeEvent) => events.push(event));
      await watcher.start();
      await wait(500);
      await fs.writeFile(path.join(tmpDir, 'private-new.md'), '# New');
      await fs.writeFile(path.join(tmpDir, 'private-existing.md'), '# Changed');
      await fs.writeFile(path.join(tmpDir, 'public.md'), '# Public');
      await waitForEvents(events, ignoreGitignore ? 1 : 3);
      await wait(400);
      expect(events.some((event) => event.path === 'public.md')).toBe(true);
      expect(events.some((event) => event.path === 'private-new.md')).toBe(!ignoreGitignore);
      expect(events.some((event) => event.path === 'private-existing.md')).toBe(!ignoreGitignore);
    },
  );

  it('監視中の .gitignore の変更は監視の再開始時に反映する', { timeout: 15000 }, async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'private.md\n');
    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: { sources: ['**/*.md'], exclude: [], ignoreGitignore: true, maxFileSize: 1024 },
      watcherConfig: { enabled: true, debounceMs: 100, awaitWriteFinishMs: 50 },
    });
    const events: FileChangeEvent[] = [];
    watcher.on('change', (event: FileChangeEvent) => events.push(event));
    await watcher.start();
    await wait(500);
    await fs.unlink(path.join(tmpDir, '.gitignore'));
    await fs.writeFile(path.join(tmpDir, 'private.md'), '# Private');
    await fs.writeFile(path.join(tmpDir, 'public.md'), '# Public');
    await waitForEvents(events);
    await wait(400);
    expect(events.some((event) => event.path === 'private.md')).toBe(false);
    await watcher.stop();
    await watcher.start();
    await wait(500);
    await fs.writeFile(path.join(tmpDir, 'private.md'), '# Updated');
    await waitForEvents(events, 2);
    expect(events.some((event) => event.path === 'private.md')).toBe(true);
  });

  it('ファイル追加を検出できる', { timeout: 10000 }, async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        sources: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ
    await wait(500); // ネイティブFSイベント購読の安定化待ち

    // ファイル作成
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    // イベントが来るまで待つ
    await waitForEvents(events, 1);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(['add', 'change']).toContain(events[0].type);
    expect(events[0].path).toBe('test.md');
  });

  it('ファイル変更を検出できる', { timeout: 10000 }, async () => {
    // 事前にファイル作成
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        sources: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    // 初回スキャンのイベントを捨てるため、start後に安定化待ちしてからリスナー登録
    await watcher.start();
    await wait(1000);

    const events: FileChangeEvent[] = [];
    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    // ファイル更新
    await fs.writeFile(testFile, '# Updated');

    // イベントが来るまで待つ
    await waitForEvents(events, 1);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('change');
    expect(events[0].path).toBe('test.md');
  });

  it('ファイル削除を検出できる', { timeout: 10000 }, async () => {
    // 事前にファイル作成
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        sources: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    // 初回スキャンのイベントを捨てるため、start後に安定化待ちしてからリスナー登録
    await watcher.start();
    await wait(1000);

    const events: FileChangeEvent[] = [];
    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    // ファイル削除
    await fs.unlink(testFile);

    // イベントが来るまで待つ
    await waitForEvents(events, 1);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unlink');
    expect(events[0].path).toBe('test.md');
  });

  it('除外パターンのファイルは検出しない', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        sources: ['**/*.md'],
        exclude: ['**/node_modules/**'],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
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
        sources: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
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

  it('サブディレクトリのファイルも検出できる', { timeout: 10000 }, async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        sources: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
      },
      watcherConfig: {
        enabled: true,
        debounceMs: 100,
        awaitWriteFinishMs: 50,
      },
    });

    watcher.on('change', (event: FileChangeEvent) => events.push(event));

    await watcher.start(); // readyまで待つ
    await wait(500); // ネイティブFSイベント購読の安定化待ち

    // サブディレクトリ作成
    const subDir = path.join(tmpDir, 'docs');
    await fs.mkdir(subDir);
    // Linux のネイティブ watcher が新しいディレクトリの監視を追加する時間を確保する。
    await wait(500);

    const testFile = path.join(subDir, 'test.md');
    await fs.writeFile(testFile, '# Test');

    // イベントが来るまで待つ（最大2秒）
    await waitForEvents(events, 1);

    expect(events).toHaveLength(1);
    expect(['add', 'change']).toContain(events[0].type);
    expect(events[0].path).toBe('docs/test.md');
  });

  it('停止後はイベントを検出しない', async () => {
    const events: FileChangeEvent[] = [];

    watcher = new FileWatcher({
      rootDir: tmpDir,
      filesConfig: {
        sources: ['**/*.md'],
        exclude: [],
        ignoreGitignore: false,
        maxFileSize: 10 * 1024 * 1024,
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
