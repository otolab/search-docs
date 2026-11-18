import * as watcher from '@parcel/watcher';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FilesConfig, WatcherConfig } from '@search-docs/types';
import { buildWatchTargets, type WatchTarget } from './watch-targets.js';
import { FileDiscovery } from './file-discovery.js';

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
  private debounceTimers = new Map<string, { timer: NodeJS.Timeout; type: FileChangeEvent['type'] }>();
  private acceptingEvents = false;
  private watchHealthy = false;
  private subscribedTargets: WatchTarget[] = [];
  private rootDir: string;
  private filesConfig: FilesConfig;
  private watcherConfig: WatcherConfig;
  private discovery: FileDiscovery;

  constructor(options: FileWatcherOptions) {
    super();
    this.rootDir = fs.realpathSync(path.resolve(options.rootDir));
    this.filesConfig = options.filesConfig;
    this.watcherConfig = options.watcherConfig;
    this.discovery = new FileDiscovery({ rootDir: this.rootDir, config: this.filesConfig });
  }

  isRunning(): boolean {
    return this.subscriptions.length > 0;
  }

  async start(): Promise<void> {
    this.acceptingEvents = true;
    this.watchHealthy = true;
    this.subscribedTargets = [];
    await this.discovery.loadGitignore();
    const targets = await buildWatchTargets(this.rootDir, this.filesConfig);

    const callback: watcher.SubscribeCallback = (err, events) => {
      if (!this.acceptingEvents) return;
      if (err) {
        this.watchHealthy = false;
        this.emit('error', err);
        return;
      }

      for (const event of events) {
        const eventType = this.convertEventType(event.type);

        if (!this.shouldProcessFile(event.path, eventType)) {
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
        this.subscribedTargets.push(target);
      } catch (err) {
        this.watchHealthy = false;
        this.emit('error', err);
      }
    }

    this.emit('ready');
  }

  covers(filePath: string): boolean {
    if (!this.acceptingEvents || !this.watchHealthy || this.discovery.shouldIgnore(filePath)) return false;
    const absolute = path.resolve(this.rootDir, filePath);
    return this.subscribedTargets.some(target => {
      const relative = path.relative(target.root, absolute);
      const logicalPath = path.relative(this.rootDir, absolute).split(path.sep).join('/');
      const ignored = target.ignorePatterns.some(pattern => minimatch(logicalPath, pattern, { dot: true }))
        || target.ignorePaths.some(ignoredPath => absolute === ignoredPath || absolute.startsWith(`${ignoredPath}${path.sep}`));
      return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
        && (target.depth === 'deep' || !relative.includes(path.sep)) && !ignored;
    });
  }

  async stop(flush = true): Promise<void> {
    this.acceptingEvents = false;
    this.watchHealthy = false;
    this.subscribedTargets = [];
    const pending = [...this.debounceTimers.entries()];
    for (const [, event] of pending) clearTimeout(event.timer);
    this.debounceTimers.clear();
    for (const sub of this.subscriptions) {
      try {
        await sub.unsubscribe();
      } catch (err) {
        this.emit('error', err);
      }
    }
    this.subscriptions = [];
    for (const [filePath, event] of pending) {
      if (flush) this.emitFileEvent(event.type, filePath);
    }
  }

  private shouldProcessFile(filePath: string, eventType: FileChangeEvent['type']): boolean {
    if (!filePath.endsWith('.md')) {
      return false;
    }

    const relativePath = path.relative(this.rootDir, filePath);

    // 既に索引済みのファイルは、除外対象になった後も削除を伝える。
    return eventType === 'unlink'
      ? this.discovery.matchesPattern(relativePath)
      : !this.discovery.shouldIgnore(relativePath);
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
      clearTimeout(existingTimer.timer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      this.emitFileEvent(type, filePath);
    }, this.watcherConfig.debounceMs);

    this.debounceTimers.set(filePath, { timer, type });
  }

  private emitFileEvent(type: FileChangeEvent['type'], filePath: string): void {
    this.emit('change', {
      type,
      path: filePath.replace(this.rootDir + '/', ''),
      timestamp: new Date(),
    } satisfies FileChangeEvent);
  }
}
