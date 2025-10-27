# ファイル監視機能の設計

## 概要

Markdownファイルの変更を監視し、自動的にインデックスを更新する機能を実装します。

## 要件

1. **ファイル変更の検出**
   - 新規作成
   - 更新
   - 削除
   - リネーム/移動

2. **効率的な更新**
   - 変更されたファイルのみ処理
   - デバウンス（短時間の連続変更をまとめる）
   - バックグラウンド処理

3. **除外パターン対応**
   - `.gitignore`の尊重
   - 設定の`exclude`パターン適用

## 実装方針

### 使用ライブラリ

#### chokidar（推奨）

**理由**:
- Node.jsのファイル監視デファクトスタンダード
- クロスプラットフォーム対応（Windows/macOS/Linux）
- `.gitignore`対応可能
- 高パフォーマンス
- 安定性が高い

**機能**:
```typescript
import chokidar from 'chokidar';

const watcher = chokidar.watch('**/*.md', {
  ignored: /(^|[\/\\])\../, // dotfilesを除外
  persistent: true,
  ignoreInitial: true,
});

watcher
  .on('add', path => console.log(`File ${path} has been added`))
  .on('change', path => console.log(`File ${path} has been changed`))
  .on('unlink', path => console.log(`File ${path} has been removed`));
```

### アーキテクチャ

```
FileWatcher
  ├─ chokidar (ファイル監視)
  ├─ Debouncer (変更イベントの集約)
  ├─ EventQueue (処理キュー)
  └─ Handler (実際の処理)
       ├─ markDirty() (変更検出時)
       └─ deleteSections() (削除検出時)
```

## 実装例

### FileWatcherクラス

```typescript
import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import ignore, { Ignore } from 'ignore';
import * as fs from 'fs/promises';

export interface FileWatcherOptions {
  /** 監視するディレクトリ */
  rootDir: string;
  /** 含めるパターン */
  include: string[];
  /** 除外するパターン */
  exclude: string[];
  /** .gitignoreを尊重するか */
  ignoreGitignore: boolean;
  /** デバウンス時間（ミリ秒） */
  debounceMs?: number;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private ignoreFilter: Ignore | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private options: Required<FileWatcherOptions>;

  constructor(options: FileWatcherOptions) {
    super();
    this.options = {
      ...options,
      debounceMs: options.debounceMs ?? 300, // デフォルト300ms
    };
  }

  /**
   * 監視を開始
   */
  async start(): Promise<void> {
    // .gitignoreの読み込み
    if (this.options.ignoreGitignore) {
      await this.loadGitignore();
    }

    // chokidarの設定
    const watchPatterns = this.options.include.map(
      pattern => `${this.options.rootDir}/${pattern}`
    );

    this.watcher = chokidar.watch(watchPatterns, {
      ignored: (path: string) => this.shouldIgnore(path),
      persistent: true,
      ignoreInitial: true, // 既存ファイルは無視（初回インデックスは別途実行）
      awaitWriteFinish: {
        stabilityThreshold: 200, // ファイル書き込み完了を200ms待つ
        pollInterval: 100,
      },
    });

    // イベントハンドラ登録
    this.watcher
      .on('add', (path) => this.handleFileEvent('add', path))
      .on('change', (path) => this.handleFileEvent('change', path))
      .on('unlink', (path) => this.handleFileEvent('unlink', path))
      .on('error', (error) => this.emit('error', error));

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

    // watcherを停止
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * ファイルイベントを処理（デバウンス付き）
   */
  private handleFileEvent(type: 'add' | 'change' | 'unlink', path: string): void {
    // 既存のタイマーをクリア
    const existingTimer = this.debounceTimers.get(path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 新しいタイマーを設定
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);

      const event: FileChangeEvent = {
        type,
        path: path.replace(this.options.rootDir + '/', ''), // 相対パスに変換
        timestamp: new Date(),
      };

      this.emit('change', event);
    }, this.options.debounceMs);

    this.debounceTimers.set(path, timer);
  }

  /**
   * .gitignoreを読み込む
   */
  private async loadGitignore(): Promise<void> {
    try {
      const gitignorePath = `${this.options.rootDir}/.gitignore`;
      const content = await fs.readFile(gitignorePath, 'utf-8');
      this.ignoreFilter = ignore().add(content);
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
  private shouldIgnore(path: string): boolean {
    // 絶対パスから相対パスに変換
    const relativePath = path.replace(this.options.rootDir + '/', '');

    // 除外パターンチェック
    for (const pattern of this.options.exclude) {
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
```

### 使用例

```typescript
import { FileWatcher } from './file-watcher.js';
import { SearchDocsServer } from './server.js';

// サーバとwatcherの連携
const watcher = new FileWatcher({
  rootDir: process.cwd(),
  include: ['**/*.md'],
  exclude: ['**/node_modules/**', '**/.git/**'],
  ignoreGitignore: true,
  debounceMs: 300,
});

watcher.on('change', async (event) => {
  console.log(`File ${event.type}: ${event.path}`);

  switch (event.type) {
    case 'add':
    case 'change':
      // ファイルをDirtyにマーク
      await server.markDirty(event.path);
      break;

    case 'unlink':
      // セクションを削除
      await server.deleteDocument(event.path);
      break;
  }
});

watcher.on('ready', () => {
  console.log('File watcher is ready');
});

watcher.on('error', (error) => {
  console.error('Watcher error:', error);
});

await watcher.start();
```

## 処理フロー

### 1. ファイル追加/変更時

```
ファイル保存
  ↓
chokidarがイベント検出
  ↓
awaitWriteFinish（書き込み完了待機）
  ↓
デバウンス（300ms）
  ↓
'change'イベント発火
  ↓
markDirty(path) 実行
  ↓
DirtyWorkerがバックグラウンドで再インデックス
```

### 2. ファイル削除時

```
ファイル削除
  ↓
chokidarがunlinkイベント検出
  ↓
デバウンス（300ms）
  ↓
'change'イベント発火（type: 'unlink'）
  ↓
deleteSectionsByPath(path) 実行
```

## 設定項目

### SearchDocsConfigへの追加

```typescript
export interface WatcherConfig {
  /** ファイル監視を有効にするか */
  enabled: boolean;
  /** デバウンス時間（ミリ秒） */
  debounceMs: number;
  /** ファイル書き込み完了の待機時間 */
  awaitWriteFinishMs: number;
}

export interface SearchDocsConfig {
  // ... 既存の設定
  watcher: WatcherConfig;
}
```

### デフォルト値

```typescript
export const DEFAULT_CONFIG: SearchDocsConfig = {
  // ... 既存の設定
  watcher: {
    enabled: true,
    debounceMs: 300,
    awaitWriteFinishMs: 200,
  },
};
```

## パフォーマンス最適化

### 1. デバウンス
短時間の連続変更をまとめて1回の処理にする。

```typescript
// 保存を3回繰り返しても、最後の1回だけ処理
save() -> 300ms以内 -> save() -> 300ms以内 -> save() -> 300ms後に処理
```

### 2. awaitWriteFinish
大きなファイルの書き込み完了を待つ。

```typescript
{
  awaitWriteFinish: {
    stabilityThreshold: 200, // 200ms変更がなければ完了と見なす
    pollInterval: 100,        // 100msごとにチェック
  }
}
```

### 3. ignoreInitial
既存ファイルのイベントを無視（初回インデックスは別途実行）。

## エラーハンドリング

### 1. ファイルアクセスエラー
```typescript
watcher.on('error', (error) => {
  console.error('Watcher error:', error);
  // 必要に応じて再起動
});
```

### 2. パーミッションエラー
`.gitignore`が読めない場合は警告を出して続行。

### 3. パスが長すぎる
Windowsの260文字制限に注意（chokidarが対応）。

## テスト戦略

### 単体テスト
```typescript
describe('FileWatcher', () => {
  it('ファイル追加を検出できる', async () => {
    const events: FileChangeEvent[] = [];
    watcher.on('change', (event) => events.push(event));

    await fs.writeFile('test.md', '# Test');
    await wait(500); // デバウンス待ち

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('add');
  });
});
```

### 統合テスト
実際のMarkdownファイルで変更検出→再インデックスの流れをテスト。

## 依存パッケージ

```json
{
  "dependencies": {
    "chokidar": "^4.0.3",
    "ignore": "^6.0.2"
  }
}
```

## メリット

1. **リアルタイム更新**: ファイル保存後すぐに検索可能
2. **効率的**: 変更されたファイルのみ処理
3. **ユーザーフレンドリー**: 手動での再インデックス不要
4. **安定性**: chokidarの実績ある実装

## 注意点

1. **リソース消費**: 大量のファイルを監視するとメモリ/CPU使用量増加
2. **デバウンス調整**: プロジェクトサイズに応じて調整が必要
3. **エディタ互換性**: 一部のエディタは一時ファイルを作成（除外が必要）

## 実装タイミング

- Phase 2.2（ファイル検索）の後に実装
- Phase 2.4（サーバコア）で統合

---

**結論**: ファイル監視機能は`chokidar`を使用して実現可能で、実装の価値も高いです。
