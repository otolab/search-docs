import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { FilesConfig, WatcherConfig } from '@search-docs/types';

// ignoreパッケージの型定義
interface Ignore {
  add(pattern: string | string[]): this;
  ignores(pathname: string): boolean;
}

// ignoreパッケージのファクトリ関数をdynamic importで使用
let ignoreFactory: (() => Ignore) | null = null;

export interface FileWatcherOptions {
  /** プロジェクトルート */
  rootDir: string;
  /** ファイル検索設定 */
  filesConfig: FilesConfig;
  /** ファイル監視設定 */
  watcherConfig: WatcherConfig;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

/**
 * ファイル監視クラス
 * chokidarを使用してMarkdownファイルの変更を監視
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private ignoreFilter: Ignore | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private rootDir: string;
  private filesConfig: FilesConfig;
  private watcherConfig: WatcherConfig;

  constructor(options: FileWatcherOptions) {
    super();
    this.rootDir = path.resolve(options.rootDir);
    this.filesConfig = options.filesConfig;
    this.watcherConfig = options.watcherConfig;
  }

  /**
   * 監視を開始
   */
  async start(): Promise<void> {
    // .gitignoreの読み込み
    if (this.filesConfig.ignoreGitignore) {
      await this.loadGitignore();
    }

    // chokidarの設定
    // 注意: chokidar 4.x では Globパターン（例: '**/*.md'）を直接watchに渡すと
    // ファイルイベントが発火しない問題があるため、rootDirを監視して
    // ignored callbackでフィルタリングする方式を採用
    this.watcher = chokidar.watch(this.rootDir, {
      ignored: (filePath: string, stats?: fs.Stats) => {
        const relativePath = path.relative(this.rootDir, filePath);

        // ディレクトリは除外しない（サブディレクトリを監視するため）
        // statsがない場合は拡張子がないものをディレクトリとみなす
        const isDirectory = stats?.isDirectory() || !path.extname(filePath);
        if (isDirectory) {
          return false;
        }

        // 除外パターンチェック
        for (const pattern of this.filesConfig.exclude) {
          const cleanPattern = pattern.replace(/\*\*/g, '').replace(/\//g, '');
          if (relativePath.includes(cleanPattern)) {
            return true;
          }
        }

        // 拡張子チェック（.mdファイル以外を除外）
        if (relativePath && !relativePath.endsWith('.md')) {
          return true;
        }

        return false;
      },
      persistent: true,
      ignoreInitial: true, // 既存ファイルは無視（初回インデックスは別途実行）
      depth: 99, // サブディレクトリも監視
      awaitWriteFinish: {
        stabilityThreshold: this.watcherConfig.awaitWriteFinishMs,
        pollInterval: 100,
      },
    });

    // イベントハンドラ登録（ready前に登録する）
    this.watcher
      .on('add', (filePath) => this.handleFileEvent('add', filePath))
      .on('change', (filePath) => this.handleFileEvent('change', filePath))
      .on('unlink', (filePath) => this.handleFileEvent('unlink', filePath))
      .on('error', (error) => this.emit('error', error));

    // readyイベントを待つ
    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => {
        this.emit('ready');
        resolve();
      });
    });
  }

  /**
   * 監視を停止
   */
  async stop(): Promise<void> {
    // デバウンスタイマーをクリア
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // watcherを停止
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * ファイルイベントを処理（デバウンス付き）
   */
  private handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): void {
    // 既存のタイマーをクリア
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 新しいタイマーを設定
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      const event: FileChangeEvent = {
        type,
        path: filePath.replace(this.rootDir + '/', ''), // 相対パスに変換
        timestamp: new Date(),
      };

      this.emit('change', event);
    }, this.watcherConfig.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * .gitignoreを読み込む
   */
  private async loadGitignore(): Promise<void> {
    try {
      // ignoreパッケージを動的にロード
      if (!ignoreFactory) {
        const ignoreModule = await import('ignore');
        ignoreFactory = ignoreModule.default as unknown as () => Ignore;
      }

      const gitignorePath = path.join(this.rootDir, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf-8');
      this.ignoreFilter = ignoreFactory().add(content);
    } catch (error) {
      // .gitignoreが存在しない場合は無視
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * パスを除外すべきか判定
   */
  private shouldIgnore(filePath: string): boolean {
    // 絶対パスから相対パスに変換
    const relativePath = filePath.replace(this.rootDir + '/', '');

    // 除外パターンチェック
    for (const pattern of this.filesConfig.exclude) {
      // 簡易的なglobマッチング（node_modules, .gitなど）
      if (relativePath.includes(pattern.replace(/\*\*/g, ''))) {
        return true;
      }
    }

    // .gitignoreチェック
    if (this.ignoreFilter) {
      return this.ignoreFilter.ignores(relativePath);
    }

    return false;
  }
}
