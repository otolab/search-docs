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
  ├─ subscriptions (複数ルート監視、includeスコープ最適化)
  ├─ ignoreパターン (COMMON_IGNORES + files.exclude)
  ├─ shouldProcessFile (includeパターン詳細マッチ)
  └─ デバウンス (300ms)
       ↓
  FileChangeEvent発火
       ↓
  SearchDocsServer
       ├─ add/change → markDirty()
       └─ unlink → deleteDocument()
```

### include スコープ最適化 (v1.8.6以降)

**2層の協調によるスコープ制限**:

1. **Layer 1 - subscribeルート（粗いスコープ制限）**
   - `files.include` パターンから静的ディレクトリプレフィックスを抽出
   - 例: `docs/**/*.md` → `docs/`、`**/*.md` → プロジェクトルート
   - プレフィックスごとに `watcher.subscribe()` を実行
   - **スコープ外のディレクトリは最初から inotify 走査の対象にならない**

2. **Layer 2 - shouldProcessFile（精密なフィルタ）**
   - `files.include` パターンの詳細マッチ + `.md` 拡張子チェック
   - 例: `docs/**` は `docs/sub/file.md` を通すが、`docs/*` は弾く

**効果**:
- Docker環境（virtiofs）での inotify 初期化時のCPU消費を大幅削減
- 大規模モノレポでの監視スコープ最適化
- `files.include` が実質的な**ディレクトリスコープ宣言**として機能

詳細: [Issue #97](https://github.com/otolab/search-docs/issues/97), [PR #98](https://github.com/otolab/search-docs/pull/98)

### 実装ファイル

**場所**: 
- `packages/server/src/discovery/file-watcher.ts` - FileWatcher本体
- `packages/server/src/discovery/include-scope.ts` - プレフィックス抽出ロジック

**主要クラス**: `FileWatcher`

```typescript
export class FileWatcher extends EventEmitter {
  private subscriptions: watcher.AsyncSubscription[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  async start(): Promise<void> {
    const { subscribeRoots, ignorePatterns } = buildWatchTargets(
      this.rootDir,
      this.filesConfig
    );

    for (const subscribeRoot of subscribeRoots) {
      const sub = await watcher.subscribe(
        subscribeRoot,
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
      this.subscriptions.push(sub);
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      await sub.unsubscribe();
    }
    this.subscriptions = [];
  }
}
```

**プレフィックス抽出ロジック**:

`buildWatchTargets()` は以下の処理を行います:

1. `extractDirectoryPrefixes()`: includeパターンから静的プレフィックスを抽出
   - 例: `"docs/**/*.md"` → `"docs"`
   - 例: `"**/*.md"` → `""` (空 = プロジェクトルート)
   - 重複排除・包含関係の解決（親が含まれていれば子は不要）

2. `resolveSubscribeRoots()`: プレフィックスを絶対パスに解決
   - 例: `"docs"` → `/path/to/project/docs`

3. ignoreパターンの構築: `COMMON_IGNORES + files.exclude`

### 主な機能

1. **ファイル変更の検出**
   - 追加（`add`）: 新規Markdownファイルの作成
   - 変更（`change`）: 既存ファイルの更新
   - 削除（`unlink`）: ファイルの削除

2. **除外パターン**
   ```typescript
   // packages/server/src/discovery/include-scope.ts
   export const COMMON_IGNORES = [
     '**/node_modules/**',
     '**/.git/**',
     '**/.pnpm-store/**',
     '**/.yarn/**',
     '**/.venv/**',
     '**/.uv/**',
     '**/dist/**',
     '**/build/**',
     '**/.next/**',
     '**/.turbo/**',
     '**/coverage/**',
     '**/.cache/**',
     '**/.search-docs/**',
     '**/__pycache__/**',
     '**/.mypy_cache/**',
     '**/.pytest_cache/**',
   ];
   ```

   **注**: COMMON_IGNORES はパフォーマンス最適化のために定義されており、@parcel/watcherのinotify初期走査時にサブツリー全体をスキップします。

3. **includeパターンのフィルタリング**
   - `files.include`パターンから静的プレフィックスを抽出し、subscribeルートを限定（Layer 1）
   - `shouldProcessFile()`で詳細マッチ（Layer 2）
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
