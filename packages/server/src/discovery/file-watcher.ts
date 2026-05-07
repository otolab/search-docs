import * as watcher from '@parcel/watcher';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FilesConfig, WatcherConfig } from '@search-docs/types';
import { buildWatchTargets } from './watch-targets.js';

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

  isRunning(): boolean {
    return this.subscriptions.length > 0;
  }

  async start(): Promise<void> {
    const targets = buildWatchTargets(this.rootDir, this.filesConfig);

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

    for (const target of targets) {
      try {
        if (!fs.statSync(target.root).isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        const sub = await watcher.subscribe(target.root, callback, {
          ignore: [...target.ignorePatterns, ...target.ignorePaths],
        });
        this.subscriptions.push(sub);
      } catch (err) {
        this.emit('error', err);
      }
    }

    this.emit('ready');
  }

  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const sub of this.subscriptions) {
      try {
        await sub.unsubscribe();
      } catch (err) {
        this.emit('error', err);
      }
    }
    this.subscriptions = [];
  }

  private shouldProcessFile(filePath: string): boolean {
    if (!filePath.endsWith('.md')) {
      return false;
    }

    const relativePath = path.relative(this.rootDir, filePath);

    if (this.filesConfig.sources && this.filesConfig.sources.length > 0) {
      const matches = this.filesConfig.sources.some((pattern) =>
        minimatch(relativePath, pattern)
      );
      if (!matches) {
        return false;
      }
    }

    return true;
  }

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

  private handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): void {
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      const event: FileChangeEvent = {
        type,
        path: filePath.replace(this.rootDir + '/', ''),
        timestamp: new Date(),
      };

      this.emit('change', event);
    }, this.watcherConfig.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }
}
