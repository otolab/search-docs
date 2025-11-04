import * as watcher from '@parcel/watcher';
import { EventEmitter } from 'events';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FilesConfig, WatcherConfig } from '@search-docs/types';

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
  private subscription: watcher.AsyncSubscription | null = null;
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
    // ignoreパターンの構築
    const ignorePatterns = this.buildIgnorePatterns();

    this.subscription = await watcher.subscribe(
      this.rootDir,
      (err, events) => {
        if (err) {
          this.emit('error', err);
          return;
        }

        for (const event of events) {
          // イベントタイプの変換
          const eventType = this.convertEventType(event.type);

          // 追加のフィルタリング（.md拡張子チェック）
          if (!this.shouldProcessFile(event.path)) {
            continue;
          }

          this.handleFileEvent(eventType, event.path);
        }
      },
      {
        ignore: ignorePatterns,
      }
    );

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

    // subscriptionを停止
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  /**
   * ignoreパターンを構築
   */
  private buildIgnorePatterns(): string[] {
    const patterns: string[] = [];

    // 一般的な除外ディレクトリ（最優先）
    const commonIgnores = [
      '**/node_modules/**',
      '**/.git/**',
      '**/.venv/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.cache/**',
      '**/.search-docs/**',  // search-docs自身のディレクトリ
    ];
    patterns.push(...commonIgnores);

    // ユーザー設定のexcludeパターン
    patterns.push(...this.filesConfig.exclude);

    // .md以外のファイルを除外
    // 注意: @parcel/watcherのignoreはGlobパターンなので、
    // "すべてのファイルのうち.md以外"を表現する必要がある
    // ディレクトリは除外しない（サブディレクトリを監視するため）
    patterns.push('**/*.!(md)');
    patterns.push('**/!(*.md)');  // 拡張子なしファイルも除外

    return patterns;
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
