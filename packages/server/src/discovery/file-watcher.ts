import * as watcher from '@parcel/watcher';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FilesConfig, WatcherConfig } from '@search-docs/types';
import { buildWatchTargets } from './include-scope.js';

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
 * @parcel/watcherを使用してMarkdownファイルの変更を監視
 */
export class FileWatcher extends EventEmitter {
  private subscriptions: watcher.AsyncSubscription[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private rootDir: string;
  private filesConfig: FilesConfig;
  private watcherConfig: WatcherConfig;

  constructor(options: FileWatcherOptions) {
    super();
    this.rootDir = fs.realpathSync(path.resolve(options.rootDir));
    this.filesConfig = options.filesConfig;
    this.watcherConfig = options.watcherConfig;
  }

  /**
   * 監視を開始
   */
  isRunning(): boolean {
    return this.subscriptions.length > 0;
  }

  async start(): Promise<void> {
    const { subscribeRoots, ignorePatterns } = buildWatchTargets(this.rootDir, this.filesConfig);

    const callback: watcher.SubscribeCallback = (err, events) => {
      if (err) {
        this.emit('error', err);
        return;
      }

      for (const event of events) {
        const eventType = this.convertEventType(event.type);

        if (!this.shouldProcessFile(event.path)) {
          continue;
        }

        this.handleFileEvent(eventType, event.path);
      }
    };

    const opts: watcher.Options = { ignore: ignorePatterns };

    for (const subscribeRoot of subscribeRoots) {
      try {
        try {
          if (!fs.statSync(subscribeRoot).isDirectory()) continue;
        } catch {
          continue;
        }
        const sub = await watcher.subscribe(subscribeRoot, callback, opts);
        this.subscriptions.push(sub);
      } catch (err) {
        this.emit('error', err);
      }
    }

    this.emit('ready');
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

    // 全subscriptionを停止（途中の例外でリークしないよう個別にtry-catch）
    for (const sub of this.subscriptions) {
      try {
        await sub.unsubscribe();
      } catch (err) {
        this.emit('error', err);
      }
    }
    this.subscriptions = [];
  }

  /**
   * ファイルを処理すべきか判定
   */
  private shouldProcessFile(filePath: string): boolean {
    // .mdファイルのみ処理
    if (!filePath.endsWith('.md')) {
      return false;
    }

    // includeパターンのチェック（オプション）
    // @parcel/watcherのignoreで大半はフィルタされているが、
    // より厳密にチェックする場合はここで追加チェック
    const relativePath = path.relative(this.rootDir, filePath);

    // filesConfig.includeが設定されている場合、それに一致するかチェック
    if (this.filesConfig.include && this.filesConfig.include.length > 0) {
      const matches = this.filesConfig.include.some((pattern) =>
        minimatch(relativePath, pattern)
      );
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  /**
   * @parcel/watcherのイベントタイプを変換
   */
  private convertEventType(type: string): 'add' | 'change' | 'unlink' {
    switch (type) {
      case 'create':
        return 'add';
      case 'update':
        return 'change';
      case 'delete':
        return 'unlink';
      default:
        return 'change';
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
}
