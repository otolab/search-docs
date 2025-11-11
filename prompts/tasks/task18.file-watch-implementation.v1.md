# Task18: ファイルWatch機能の実装状況確認と改善

## 作業概要

ファイルWatch機能について実装を行いたいというユーザーリクエストに対応します。まず現在の実装状況を調査・整理し、必要な改善を行います。

## 調査結果

### 既存の実装状況

#### 1. FileWatcherクラス (packages/server/src/discovery/file-watcher.ts)

**実装済み機能**:
- ✅ chokidar 4.x を使用したファイル監視
- ✅ ファイルイベントの検出（add, change, unlink）
- ✅ デバウンス機能（連続変更を1イベントに集約）
- ✅ .gitignore の尊重
- ✅ 除外パターンのフィルタリング
- ✅ サブディレクトリの監視
- ✅ EventEmitterベースのイベント発火

**設計のポイント**:
- chokidar 4.x の仕様対応（Globパターンを直接watchに渡すとイベントが発火しない問題への対処）
- rootDirを監視し、ignored callbackでフィルタリング
- ignoreInitial: true（既存ファイルは無視、初回インデックスは別途実行）
- awaitWriteFinish: 書き込み完了を待つ（デフォルト設定で対応）

#### 2. SearchDocsServerへの統合 (packages/server/src/server/search-docs-server.ts)

**実装済み機能**:
- ✅ FileWatcherの初期化（config.watcher.enabledフラグで制御）
- ✅ イベントハンドラの登録
- ✅ ファイル変更イベントの処理（handleFileChange）
  - add/change: ファイル読み込み → ストレージ保存 → IndexRequest作成
  - unlink: セクション削除 → ストレージから削除
- ✅ サーバ起動時のWatcher開始
- ✅ サーバ停止時のWatcher停止

#### 3. テスト (packages/server/src/discovery/__tests__/file-watcher.test.ts)

**実装済みテストケース**:
- ✅ ファイル追加の検出
- ✅ ファイル変更の検出
- ✅ ファイル削除の検出
- ✅ 除外パターンの動作
- ✅ デバウンス機能
- ✅ サブディレクトリのファイル検出
- ✅ 停止後のイベント検出なし

### 型定義の確認

```typescript
// WatcherConfig
export interface WatcherConfig {
  enabled: boolean;
  debounceMs: number;
  awaitWriteFinishMs: number;
}

// FileChangeEvent
export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}
```

## 現状の評価

### ✅ 実装済みの項目
1. ファイルWatch機能の基本実装
2. SearchDocsServerへの統合
3. テストコードの整備
4. エラーハンドリング

### 🔍 確認が必要な項目
1. 実際のテスト実行結果
2. 統合テストの有無
3. エッジケースの対応状況

### 💡 改善の余地がある項目
1. パス解決の問題（line:137でevent.pathを直接fs.readFileに渡している）
   - event.pathは相対パスに変換済みだが、読み込みには絶対パスが必要
2. ログレベルの調整（console.logの使用）
3. ドキュメント・設定ファイルでのwatcher設定の説明

## 実施した修正

### 1. パス解決の問題修正

**問題箇所**: `packages/server/src/server/search-docs-server.ts:137`

**問題内容**:
- `FileWatcher`から受け取る`event.path`は相対パスに変換済み
- しかし、`fs.readFile(event.path, 'utf-8')`で直接読み込もうとしていた
- 絶対パスに変換する必要がある

**修正内容**:
```typescript
// 修正前
const content = await fs.readFile(event.path, 'utf-8');

// 修正後
const absolutePath = path.join(this.config.project.root, event.path);
const content = await fs.readFile(absolutePath, 'utf-8');
```

また、`path`モジュールのインポートを追加：
```typescript
import * as path from 'path';
```

### 2. テスト結果

全テストがパス（69 tests passed）:
- ✅ FileWatcher関連: 7 tests
- ✅ IndexWorker関連: 9 tests
- ✅ MarkdownSplitter関連: 25 tests
- ✅ その他統合テスト: 28 tests

型チェックもクリア。

## 次のアクション

1. ✅ 現状調査完了
2. ✅ テスト実行による動作確認
3. ✅ パス解決の問題修正
4. ✅ テストによる修正の検証

## 追加の改善提案（今後の課題）

1. **ログレベルの調整**
   - 現在`console.log`を使用しているが、ロギングライブラリの導入を検討
   - ログレベル（debug, info, warn, error）の適切な分類

2. **エラーハンドリングの強化**
   - ファイル読み込みエラーの詳細なハンドリング
   - エラー時のリトライロジック

3. **ドキュメントの追加**
   - Watcher設定の詳細なドキュメント化
   - トラブルシューティングガイドの作成

## EMFILE問題の発見と対策

### 問題の詳細

大規模プロジェクト（例: large-test-project）で以下のエラーが発生：

```
File watcher error: Error: EMFILE: too many open files, watch
  errno: -24,
  syscall: 'watch',
  code: 'EMFILE'
```

### 原因分析

現在の実装の問題点：

1. **監視範囲が広すぎる**
   - `chokidar.watch(this.rootDir)` でルート全体を監視
   - `depth: 99` で深い階層まで監視
   - 大規模プロジェクトでは数万ファイルが対象になる

2. **ignored callbackの限界**
   - フィルタリングは行っているが、chokidarは最初に全ディレクトリをスキャン
   - ファイルディスクリプタを大量に消費

3. **macOS/Linuxのファイルディスクリプタ制限**
   - デフォルト制限（通常256-1024）を超過

### 対策の方針

1. **usePolling: true への切り替え検討**
   - ファイルディスクリプタを使わない
   - パフォーマンスとのトレードオフ

2. **監視対象の絞り込み**
   - includeパターンに基づいた監視
   - depth制限の追加

3. **設定による制御**
   - ユーザーが選択できるようにする

### 実施した対策

#### 重要な発見：graceful-fsについて

**誤解の訂正**:
- ❌ **誤**: `graceful-fs`を明示的に追加して`gracefulify()`を呼ぶ必要がある
- ✅ **正**: `chokidar`は既に内部で`graceful-fs`を使用している

**確認結果**:
```bash
npm ls graceful-fs
# chokidar → graceful-fs の依存関係が既に存在
```

**graceful-fsの限界**:
- `graceful-fs`は**個々のファイルI/O操作**（`readFile`, `writeFile`など）の`EMFILE`エラーをリトライで処理
- しかし、**監視開始時**にOSリソース上限に達した場合は対応できない
- つまり、`chokidar`を使っても`EMFILE`が発生するのは、監視プロセス自体がリソースを使い切るため

**根本的な対策が必要**:
1. OSレベルの`ulimit`引き上げ
2. `usePolling`によるファイルディスクリプタ回避
3. `debounce`処理の最適化
4. 監視範囲の絞り込み

#### 1. usePollingオプションの追加

**変更内容**:
- `WatcherConfig`に以下のフィールドを追加（`packages/types/src/config.ts`）:
  ```typescript
  usePolling?: boolean;        // デフォルト: false
  pollingInterval?: number;    // デフォルト: 1000ms
  ```
- `file-watcher.ts`でこれらのオプションをchokidarに渡すように実装

**使用方法**:
```json
{
  "watcher": {
    "enabled": true,
    "debounceMs": 300,
    "awaitWriteFinishMs": 200,
    "usePolling": true,         // 大規模プロジェクトで有効化
    "pollingInterval": 1000     // 1秒ごとにポーリング
  }
}
```

**効果**:
- `usePolling: true`でファイルディスクリプタを使わずに監視
- 大規模プロジェクトでもEMFILEエラーを回避
- パフォーマンスとのトレードオフ（CPU使用率は上がるが、安定性向上）

#### 2. テスト結果

- ✅ 型チェック: PASS
- ✅ FileWatcherテスト: 7 tests passed
- ✅ 既存機能への影響なし

## 既存の実装確認

### ✅ 既に実装されていた対策

1. **ignoreInitial: true**（`file-watcher.ts:107`）
   - 起動時の既存ファイルに対する`add`イベントを発火しない
   - 初回インデックスは別途`rebuildIndex`で実行
   - 起動時のイベント嵐を防止

2. **debounce処理**（`file-watcher.ts:156-177`）
   - `handleFileEvent`メソッドで実装
   - ファイルごとにタイマーを管理（`debounceTimers: Map`）
   - 設定可能な`debounceMs`（デフォルト300ms）
   - 短時間の連続変更を1回のイベントに集約

**効果**:
```typescript
// 起動時
ignoreInitial: true  // → 既存ファイルのaddイベントなし

// 起動後の連続変更
file.md 変更 → debounce開始
file.md 変更 → タイマーリセット
file.md 変更 → タイマーリセット
(300ms経過) → 1回だけイベント発火
```

## 最終的な対策まとめ

### ✅ 今回実装した対策

1. **usePollingオプションの追加**
   - 設定で`usePolling: true`にすることでファイルディスクリプタを使わずに監視
   - 大規模プロジェクト向けの選択肢を提供

### ❌ 不要だった対策

1. **graceful-fsの明示的な追加**
   - chokidarが既に内部で使用しているため不要
   - `gracefulify()`呼び出しは削除

### 📝 追加で検討すべき対策（ユーザー側）

1. **ulimit の引き上げ**（macOS/Linux）
   ```bash
   ulimit -n 10480  # 一時的
   # ~/.zshrc または ~/.bashrc に追加して永続化
   ```

2. **除外パターンの最適化**
   - `.search-docs.json`の`exclude`パターンを見直し
   - 不要なディレクトリを確実に除外

3. **監視範囲の絞り込み**
   - `include`パターンを具体的に指定
   - ワイルドカードの使用を最小限に

## 推奨設定

### 小〜中規模プロジェクト（デフォルト）
```json
{
  "watcher": {
    "enabled": true,
    "debounceMs": 300,
    "awaitWriteFinishMs": 200
  }
}
```

### 大規模プロジェクト（large-test-projectなど）
```json
{
  "watcher": {
    "enabled": true,
    "debounceMs": 300,
    "awaitWriteFinishMs": 200,
    "usePolling": true,
    "pollingInterval": 2000
  }
}
```

**注意**: `usePolling: true`の場合、CPU使用率が若干上がります。必要な場合のみ有効化してください。

## 作業履歴

- 2025-11-04 14:00: 調査開始、既存実装の確認
- 2025-11-04 14:08: FileWatcherテスト実行、全テストパス確認
- 2025-11-04 14:09: パス解決の問題を発見
- 2025-11-04 14:10: 修正実施、型チェック・テスト実行、全パス
- 2025-11-04 14:12: 初回作業完了
- 2025-11-04 14:15: EMFILE問題の報告を受け、調査開始
- 2025-11-04 14:16: graceful-fs + usePollingオプションの対策を実施
- 2025-11-04 14:18: 対策完了、全テストパス確認
