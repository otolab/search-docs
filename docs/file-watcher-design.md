# ファイル監視機能

## 概要

Markdownファイルの変更を監視し、自動的にインデックスを更新する機能です。ファイルの追加・変更・削除を検出し、バックグラウンドで再インデックスを実行します。

## 採用技術

**@parcel/watcher** を使用しています。

**採用理由**:
- **大規模プロジェクト対応**: ネイティブC++実装により、10万ファイル規模でも効率的
- **Node.jsへの負荷が低い**: イベントスロットリングをネイティブスレッドで実行
- **簡単セットアップ**: プリビルドバイナリで追加の依存なし
- **実績**: Parcel, Nuxt.js, Viteで採用済み

他の選択肢（chokidar、Watchman直接利用）と比較した詳細は [ADR-017](./architecture-decisions.md#adr-017-parcelwatcherによるファイル監視) を参照。

## 実装

### アーキテクチャ

```
FileWatcher (@parcel/watcher)
  ├─ subscription (ネイティブC++監視)
  ├─ ignoreパターン (除外フィルタ)
  ├─ shouldProcessFile (includeパターンチェック)
  └─ デバウンス (300ms)
       ↓
  FileChangeEvent発火
       ↓
  SearchDocsServer
       ├─ add/change → markDirty()
       └─ unlink → deleteDocument()
```

### 実装ファイル

**場所**: `packages/server/src/discovery/file-watcher.ts`

**主要クラス**: `FileWatcher`

```typescript
export class FileWatcher extends EventEmitter {
  private subscription: watcher.AsyncSubscription | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  async start(): Promise<void> {
    const ignorePatterns = this.buildIgnorePatterns();

    this.subscription = await watcher.subscribe(
      this.rootDir,
      (err, events) => {
        for (const event of events) {
          const eventType = this.convertEventType(event.type);
          if (this.shouldProcessFile(event.path)) {
            this.handleFileEvent(eventType, event.path);
          }
        }
      },
      { ignore: ignorePatterns }
    );
  }

  async stop(): Promise<void> {
    await this.subscription?.unsubscribe();
  }
}
```

### 主な機能

1. **ファイル変更の検出**
   - 追加（`add`）: 新規Markdownファイルの作成
   - 変更（`change`）: 既存ファイルの更新
   - 削除（`unlink`）: ファイルの削除

2. **除外パターン**
   ```typescript
   const commonIgnores = [
     '**/node_modules/**',
     '**/.git/**',
     '**/.venv/**',
     '**/dist/**',
     '**/build/**',
     '**/.search-docs/**',
   ];
   ```

3. **includeパターンのフィルタリング**
   - `filesConfig.include`に基づいて監視対象を絞り込み
   - `minimatch`による柔軟なパターンマッチング

4. **デバウンス機能**
   - デフォルト300ms
   - 短時間の連続変更をまとめて1回の処理に

### 設定

**WatcherConfig**（`packages/types/src/config.ts`）:

```typescript
export interface WatcherConfig {
  enabled: boolean;        // ファイル監視を有効にするか
  debounceMs: number;      // デバウンス時間（ミリ秒）
  awaitWriteFinishMs: number;  // （@parcel/watcherでは未使用）
}
```

**デフォルト値**:

```typescript
watcher: {
  enabled: true,
  debounceMs: 300,
  awaitWriteFinishMs: 200,  // 互換性のため残存、実際は使用されない
}
```

## 処理フロー

### ファイル追加/変更時

```
ファイル保存
  ↓
@parcel/watcher (ネイティブC++)がイベント検出
  ↓
ignoreパターンでフィルタリング
  ↓
shouldProcessFile() (includeパターン・拡張子チェック)
  ↓
デバウンス（300ms）
  ↓
'change'イベント発火
  ↓
SearchDocsServer.markDirty(path)
  ↓
IndexWorkerがバックグラウンドで再インデックス
```

### ファイル削除時

```
ファイル削除
  ↓
@parcel/watcherがunlinkイベント検出
  ↓
デバウンス（300ms）
  ↓
'change'イベント発火（type: 'unlink'）
  ↓
SearchDocsServer.deleteDocument(path)
```

## パフォーマンス特性

### @parcel/watcherの利点

1. **ネイティブC++実装**
   - イベントスロットリングをネイティブスレッドで実行
   - Node.jsメインプロセスを圧迫しない

2. **大規模プロジェクトに強い**
   - 10万ファイル規模でも効率的
   - 大量ファイル変更（npm install, git checkout）に耐性あり

3. **Watchman連携（オプション）**
   - システムにWatchmanがあれば自動的に利用
   - 常駐デーモンがファイルシステム変更をメモリ保持
   - **必須ではない**: Watchmanなしでも十分に動作

4. **プリビルドバイナリ**
   - 13種類のプラットフォーム対応
   - 通常のnpm installでビルド不要
   - Python等の依存なし

### デバウンスの効果

短時間の連続変更をまとめて1回の処理にする：

```
保存 → 300ms以内 → 保存 → 300ms以内 → 保存 → 300ms後に1回処理
```

## テスト

**テストファイル**: `packages/server/src/discovery/__tests__/file-watcher.test.ts`

**テストケース**（全7テスト）:
- ✅ ファイル追加を検出できる
- ✅ ファイル変更を検出できる
- ✅ ファイル削除を検出できる
- ✅ 除外パターンのファイルは検出しない
- ✅ デバウンスが機能する
- ✅ サブディレクトリのファイルも検出できる
- ✅ 停止後はイベントを検出しない

## 今後の検討事項

1. **Watchmanの推奨**
   - ドキュメントにWatchmanインストールのメリットを記載
   - ただし必須とはしない

2. **パフォーマンスモニタリング**
   - 大規模プロジェクトでの実際のメモリ使用量・CPU使用率の測定
   - 必要に応じてログ追加

## 関連ドキュメント

- **アーキテクチャ決定記録**: [ADR-017](./architecture-decisions.md#adr-017-parcelwatcherによるファイル監視) - 技術選定の詳細
- **実装ファイル**: `packages/server/src/discovery/file-watcher.ts`
- **テストファイル**: `packages/server/src/discovery/__tests__/file-watcher.test.ts`
