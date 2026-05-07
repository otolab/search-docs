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

### アーキテクチャ（3層構造）

Issue #99で導入されたツリーウォークベースの3層フィルタリング構造：

```
Layer 0: ツリーウォーク（buildWatchTargets）
  パターン解析 + ディレクトリ走査
    ↓
  deep/shallow subscription を決定
    ↓
Layer 1: @parcel/watcher subscription
  deep root: 再帰監視（COMMON_IGNORES + exclude のみ）
  shallow root: 直下ファイルのみ（全サブディレクトリを ignore）
    ↓
Layer 2: shouldProcessFile（精密フィルタ）
  sources パターンの minimatch + .md 拡張子チェック
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

2. **3層フィルタリング**
   - **Layer 0**: ツリーウォーク（`buildWatchTargets`）
     - `sources`パターンを解析し、shallow/deepを判定
     - glob中間パターンを実ディレクトリに展開
     - subscription単位（deep root, shallow root）を決定
   - **Layer 1**: @parcel/watcher subscription
     - deep root: 再帰監視（COMMON_IGNORES + exclude のみ）
     - shallow root: 直下ファイルのみ（全サブディレクトリをignore）
   - **Layer 2**: 精密フィルタ（`shouldProcessFile`）
     - `sources`パターンの minimatch + .md 拡張子チェック

3. **共通除外パターン（COMMON_IGNORES）**
   ```typescript
   export const COMMON_IGNORES = [
     '**/node_modules/**',
     '**/.git/**',
     '**/.venv/**',
     '**/dist/**',
     '**/build/**',
     '**/.search-docs/**',
   ];
   ```

4. **shallow/deep 監視の自動判定**
   - パターンに `**` が含まれる → deep（再帰監視）
   - `**` がない → shallow（直下のみ）

   | パターン | 判定 | 意味 |
   |---------|------|------|
   | `docs/**` | deep | docs/ 以下を再帰的に監視 |
   | `docs/**/*.md` | deep | 同上 |
   | `*.md` | shallow | ルート直下のみ |
   | `docs/*` | shallow | docs/ 直下のみ |
   | `README.md` | shallow | ルート直下の特定ファイル |

5. **glob プレフィックス解決**
   `systems/*/docs/**` のように中間にglobを含むパターンは、ディレクトリ走査で実パスに展開：
   ```
   systems/ → app-a/docs/ → deep
           → app-b/docs/ → deep
   ```

6. **デバウンス機能**
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

### 起動時（Layer 0: ツリーウォーク）

```
FileWatcher.start()
  ↓
buildWatchTargets(projectRoot, sources, exclude)
  ↓
パターン解析（analyzePattern）
  - `**` 有無で shallow/deep 判定
  - glob プレフィックスを実ディレクトリに展開
  ↓
WatchTarget[] を生成
  - deep: { type: 'deep', root: 'docs/' }
  - shallow: { type: 'shallow', root: './', ignore: ['docs/', 'prompts/'] }
  ↓
各 WatchTarget に対して subscription 作成
```

### ファイル追加/変更時（Layer 1 → Layer 2）

```
ファイル保存
  ↓
@parcel/watcher (ネイティブC++)がイベント検出
  ↓
Layer 1: subscription のignoreパターンでフィルタリング
  - deep: COMMON_IGNORES + exclude のみ
  - shallow: COMMON_IGNORES + exclude + 全サブディレクトリ
  ↓
Layer 2: shouldProcessFile() (sources パターン・拡張子チェック)
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
Layer 1 → Layer 2 フィルタリング（同上）
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

**テストファイル**:
- `packages/server/src/discovery/__tests__/file-watcher.test.ts`
- `packages/server/src/discovery/__tests__/watch-targets.test.ts`

**テストケース（file-watcher.test.ts）**（全7テスト）:
- ✅ ファイル追加を検出できる
- ✅ ファイル変更を検出できる
- ✅ ファイル削除を検出できる
- ✅ 除外パターンのファイルは検出しない
- ✅ デバウンスが機能する
- ✅ サブディレクトリのファイルも検出できる
- ✅ 停止後はイベントを検出しない

**テストケース（watch-targets.test.ts）**（全25テスト）:
- ✅ パターン解析（analyzePattern）: 14テスト
  - deep/shallow判定、globプレフィックス抽出、特殊ケース
- ✅ WatchTargets構築（buildWatchTargets）: 11テスト
  - deep/shallow分離、glob展開、複合パターン、除外処理

## 後方互換

Issue #99で `files.include` → `files.sources` にリネームされましたが、後方互換性を維持：

- `files.include` は `files.sources` にマッピングされて動作
- バリデーターは両方を受け付ける
- 既存プロジェクトはそのまま動作

## 今後の検討事項

1. **Watchmanの推奨**
   - ドキュメントにWatchmanインストールのメリットを記載
   - ただし必須とはしない

2. **パフォーマンスモニタリング**
   - 大規模プロジェクトでの実際のメモリ使用量・CPU使用率の測定
   - 必要に応じてログ追加

## 関連ドキュメント

- **アーキテクチャ決定記録**:
  - [ADR-017](./architecture-decisions.md#adr-017-parcelwatcherによるファイル監視) - 技術選定の詳細
  - [ADR-019](./architecture-decisions.md#adr-019-files-sources-リネームとツリーウォーク監視) - sources リネーム + ツリーウォーク
- **実装ファイル**:
  - `packages/server/src/discovery/file-watcher.ts`
  - `packages/server/src/discovery/watch-targets.ts`
- **テストファイル**:
  - `packages/server/src/discovery/__tests__/file-watcher.test.ts`
  - `packages/server/src/discovery/__tests__/watch-targets.test.ts`
- **関連Issue/PR**:
  - Issue #99: files.include → files.sources リネーム + shallow/deep ツリーウォーク監視
  - PR #100: 実装完了
