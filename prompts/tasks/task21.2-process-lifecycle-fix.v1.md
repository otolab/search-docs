# task21.2: プロセスライフサイクル管理の修正

## 作業目的

task21（StartupSyncWorker実装）の検証中に発見された、プロセスライフサイクル管理の問題を修正する。

## 発見された問題

### 問題の発見経緯

karte-io-systemsプロジェクトでsearch-docsサーバを起動テストした際、**7個のサーバプロセスと6個のPython workerプロセスが同時起動**していることを発見。

```
# プロセス確認結果
- search-docsサーバ: 7プロセス
- Python worker: 6プロセス（各2GB以上のメモリ消費、CPU 100%超）
- 合計メモリ使用量: 10GB以上
- 合計CPU使用率: 600%以上
```

### 根本原因

**起動タイムアウト時の不適切な処理**（`packages/cli/src/commands/server/start.ts:200-206`）:

```typescript
if (!started) {
  // 起動失敗、PIDファイル削除
  await deletePidFile(projectRoot);  // ← PIDファイルだけ削除
  throw new Error('Server startup timeout. Check logs for details.');
}
```

**何が起こるか**:
1. `spawnServer()`でサーバプロセスを起動（デーモンモード）
2. 30秒間ヘルスチェックで起動待機
3. 大規模プロジェクトでは初期インデックス同期に時間がかかりタイムアウト
4. **PIDファイルのみ削除**され、プロセスは動き続ける（孤児プロセス化）
5. 次回の`server start`でPIDファイルがないため「未起動」と判断
6. 新しいサーバプロセスが起動
7. 繰り返し → 多重起動

### その他の問題

1. **既存プロセスチェックの不完全性**（start.ts:85-95）
   - プロセスが存在し応答する場合のみエラー
   - プロセスが存在するが応答しない場合（ハング/ゾンビ状態）を処理できない

2. **PIDファイル管理の責務が不明確**
   - 現状: CLIがPIDファイルを作成・管理
   - 一般的: サーバプロセス自身がPIDファイルを管理
   - 結果: 異常終了時に不整合が発生

## 作業目標

### フェーズ1: 緊急修正（必須）

タイムアウト時にプロセスをkillする

- [ ] start.ts: タイムアウト時にプロセスをkill
- [ ] テストで動作確認

### フェーズ2: 既存プロセスチェックの改善（推奨）

応答しないプロセスを適切に処理する

- [ ] 既存プロセスチェックのロジック改善
  - プロセス存在 + 応答する → エラー
  - プロセス存在 + 応答しない → kill + PIDファイル削除 + 起動続行
  - プロセス不存在 → PIDファイル削除 + 起動続行
- [ ] テストで動作確認

### フェーズ3: PIDファイル管理の再設計（オプション）

サーバプロセス自身がPIDファイルを管理する標準パターンに変更

- [ ] サーバプロセス側でPIDファイル作成・削除
- [ ] CLI側はPIDファイル作成を削除
- [ ] シグナルハンドリングの実装
- [ ] テストで動作確認

## 現状分析

### PIDファイル管理の責務

#### 現在の実装

```
┌─────────────────────┐
│   CLI (launcher)    │ ← PIDファイル作成・削除
└──────────┬──────────┘
           │ spawn (daemon)
           ▼
┌─────────────────────┐
│ Server Process      │ ← PIDファイルを知らない
│  - 起動             │
│  - サービス提供     │
│  - 終了（SIGTERM）  │ ← PIDファイル削除しない
└─────────────────────┘
```

**問題点**:
- サーバプロセスが自分のPIDファイルを管理していない
- 異常終了時にPIDファイルが残る
- タイムアウト時の不整合

#### 標準的な実装パターン

```
┌─────────────────────┐
│   CLI (launcher)    │ ← プロセスチェック・spawn のみ
└──────────┬──────────┘
           │ spawn
           ▼
┌─────────────────────┐
│ Server Process      │ ← PIDファイル管理
│  1. 起動時:         │
│     - PID確認       │
│     - PIDファイル作成│
│  2. 実行中:         │
│     - サービス提供  │
│  3. 終了時:         │
│     - PIDファイル削除│
└─────────────────────┘
```

**利点**:
- 責務が明確
- 異常終了時もSIGTERMでPIDファイル削除
- CLIがシンプルになる

### 既存プロセスチェックのロジック

#### 現在の実装（start.ts:81-103）

```typescript
const existingPid = await readPidFile(projectRoot);

if (existingPid && isProcessAlive(existingPid.pid)) {
  // プロセスが存在 → エラー
  throw new Error('Server is already running');
}

if (existingPid) {
  // プロセスは存在しない → PIDファイル削除
  await deletePidFile(projectRoot);
}
```

**不足しているケース**:
- プロセスは存在するが応答しない（ハング/ゾンビ状態）

#### 改善後のロジック

```
PIDファイル存在？
  ├─ No → 起動続行
  └─ Yes
      │
      プロセス存在？
      ├─ No → PIDファイル削除 → 起動続行
      └─ Yes
          │
          ヘルスチェック成功？
          ├─ Yes → エラー（既に起動中）
          └─ No → kill → PIDファイル削除 → 起動続行
```

## 実装計画

### ステップ1: フェーズ1実装（緊急修正）

1. start.tsのタイムアウト処理を修正
   ```typescript
   if (!started) {
     // プロセスをkill
     if (serverProcess.pid) {
       try {
         process.kill(serverProcess.pid, 'SIGTERM');
         await new Promise(resolve => setTimeout(resolve, 2000));
         if (isProcessAlive(serverProcess.pid)) {
           process.kill(serverProcess.pid, 'SIGKILL');
         }
       } catch (error) {
         // プロセスが既に終了している等
       }
     }
     await deletePidFile(projectRoot);
     throw new Error('Server startup timeout.');
   }
   ```

2. テストで確認
   - 大規模プロジェクトで起動タイムアウトさせる
   - プロセスが残っていないことを確認
   - 次回起動が成功することを確認

### ステップ2: フェーズ2実装（既存プロセスチェック改善）

1. 既存プロセスチェックのロジック改善
   ```typescript
   if (existingPid) {
     const processExists = isProcessAlive(existingPid.pid);

     if (processExists) {
       // ヘルスチェック
       try {
         const client = new SearchDocsClient({
           baseUrl: `http://${existingPid.host}:${existingPid.port}`
         });
         await client.healthCheck();
         // 応答する → エラー
         throw new Error('Server is already running');
       } catch (error) {
         // 応答しない → kill
         process.kill(existingPid.pid, 'SIGTERM');
         await new Promise(resolve => setTimeout(resolve, 2000));
         if (isProcessAlive(existingPid.pid)) {
           process.kill(existingPid.pid, 'SIGKILL');
         }
         await deletePidFile(projectRoot);
       }
     } else {
       // プロセス不存在 → PIDファイル削除
       await deletePidFile(projectRoot);
     }
   }
   ```

2. テストで確認
   - 正常起動中のサーバに対して起動 → エラー
   - ハングしたサーバに対して起動 → kill + 起動成功
   - 死んだサーバのPIDファイルに対して起動 → 削除 + 起動成功

### ステップ3: フェーズ3実装（PIDファイル管理の再設計）※オプション

1. Server側でPIDファイル管理を実装
   - packages/server/src/bin/server.ts
   - 起動時にPIDファイル作成
   - SIGTERM/SIGINTでPIDファイル削除

2. CLI側でPIDファイル作成を削除
   - packages/cli/src/commands/server/start.ts
   - writePidFile()呼び出しを削除

3. テストで確認
   - 正常起動・停止
   - 異常終了時のPIDファイル削除
   - 複数起動防止

## 期待される効果

### フェーズ1
- ✅ タイムアウト時のプロセス多重起動を防止
- ✅ リソース使用量の異常増加を防止

### フェーズ2
- ✅ ハング状態のサーバを自動的に回復
- ✅ 手動でのプロセスkillが不要

### フェーズ3
- ✅ 責務の明確化
- ✅ 異常終了時の整合性向上
- ✅ 標準的なデーモン実装パターンへの準拠

## メモ

- フェーズ1は必須（リリース前に修正）
- フェーズ2は推奨（ユーザビリティ向上）
- フェーズ3はオプション（設計改善だが影響範囲大）
- まずはフェーズ1から着手

## 作業完了 (2025-11-07)

### 実装内容

ユーザーからのフィードバックで、**フェーズ3（PIDファイル管理の再設計）が本質的な修正**であると確認され、Phase3を優先実装しました。

#### 1. types packageへのPID型定義追加

新規ファイル `packages/types/src/pid.ts`:
- `PidFileContent` インターフェイスを定義
- `getPidFilePath()` ヘルパー関数を実装
- server/cli間で型定義を共有

#### 2. server側でPIDファイル管理を実装

新規ファイル `packages/server/src/utils/pid.ts`:
- `writePidFile()`: PIDファイル作成
- `readPidFile()`: PIDファイル読み込み
- `deletePidFile()`: PIDファイル削除
- `isProcessAlive()`: プロセス存在確認

`packages/server/src/bin/server.ts`の修正:
- 起動時に既存PIDファイルをチェック（重複起動防止）
- プロセス起動後にPIDファイル作成
- SIGTERM/SIGINTハンドラでPIDファイル削除

#### 3. cli側でPIDファイル作成を削除・修正

`packages/cli/src/commands/server/start.ts`の修正:
- `writePidFile()` 呼び出しを削除
- タイムアウト時にSIGTERMでプロセスをkill（サーバのハンドラでPIDファイル削除される）
- フォアグラウンドモード終了時のPIDファイル削除処理を削除

### テスト結果

✅ デーモンモードで起動成功（サーバがPIDファイル作成）
✅ PIDファイル内容確認（server側のprocess.pidが記録されている）
✅ 既存サーバ検出（重複起動時にエラー）
✅ サーバ停止時にPIDファイル削除確認
✅ 孤児プロセスが残らないことを確認

### リリース内容

**Changeset**: `.changeset/pid-management-fix.md`

**公開バージョン**:
- @search-docs/types: 1.0.10 → 1.0.11
- @search-docs/server: 1.1.5 → 1.1.6
- @search-docs/cli: 1.0.16 → 1.0.17
- @search-docs/client: 1.0.10 → 1.0.11
- @search-docs/db-engine: 1.0.14 → 1.0.15
- @search-docs/storage: 1.0.8 → 1.0.9
- @search-docs/mcp-server: 1.0.21 → 1.0.22

**コミット**: `8d81c7a - fix: PIDファイル管理をサーバ側に移管`

### 解決された問題

✅ タイムアウト時のサーバプロセス孤児化を根本解決
✅ 複数サーバプロセスの同時起動を防止
✅ PIDファイル管理の責務を明確化（標準的なデーモンパターンに準拠）
✅ 異常終了時の整合性向上（SIGTERMハンドラでクリーンアップ）

### 今後の課題

フェーズ2（既存プロセスチェックの改善）は現状必須ではないが、将来的な改善として検討可能:
- プロセスが存在するが応答しない場合の自動killと再起動
- より堅牢なヘルスチェック実装

ただし、Phase3の実装により孤児プロセス問題は解決されたため、優先度は低い。

## 追加修正: DB接続の非ブロック化 (2025-11-07)

### 発見された問題

Phase3実装後の検証で、サーバー起動時に「Not connected to database」エラーが多発することが判明:

```
[IndexWorker] Error in initial processing: Error: Not connected to database
Failed to index AGENTS.md: Error: Not connected to database
```

### 原因分析

サーバー起動フロー:
1. `SearchDocsServer.start()` が呼ばれる
2. `dbEngine.connect()` を**待たずに**すぐにワーカーを起動
3. IndexWorker/StartupSyncWorkerがDB操作を試みる
4. DB接続がまだ完了していない → エラー

問題点:
- `dbEngine.connect()` は非同期だが、await していない
- ワーカーはDB接続完了を待たずに即座に起動
- 結果的にDBが準備できていない状態でリクエストが発行される

### 実装内容

#### 1. OpenPromiseパターンの導入 (db-engine)

`packages/db-engine/src/typescript/index.ts`:

```typescript
// openPromiseパターン: 接続完了を外部から待機可能にする
private connectedPromise: Promise<void>;
private resolveConnected!: () => void;
private rejectConnected!: (error: Error) => void;

constructor(options: DBEngineOptions = {}) {
  super();
  // 接続完了を待機できるPromiseを作成
  this.connectedPromise = new Promise((resolve, reject) => {
    this.resolveConnected = resolve;
    this.rejectConnected = reject;
  });
}

async connect(): Promise<void> {
  // ... 接続処理 ...

  // DB準備完了時にresolve
  await this.waitForReady(workerError, () => workerExited);
  // resolveConnected()がwaitForReady内で呼ばれる
}

waitForConnection(): Promise<void> {
  return this.connectedPromise;
}
```

#### 2. サーバー起動フローの修正 (server)

`packages/server/src/server/search-docs-server.ts`:

```typescript
async start(): Promise<void> {
  this.startTime = Date.now();

  // DB接続をバックグラウンドで開始（サーバ起動をブロックしない）
  this.dbEngine.connect().catch((error) => {
    console.error('[SearchDocsServer] DB connection failed:', error);
  });

  // DB接続完了後にDB依存のワーカーを起動
  this.dbEngine.waitForConnection().then(() => {
    // パフォーマンスログを開始
    if (process.env.ENABLE_PERFORMANCE_LOG === '1') {
      const logPath = process.env.PERFORMANCE_LOG_PATH;
      this.dbEngine.startPerformanceLogging(logPath);
    }

    // 起動時にインデックスを同期（バックグラウンドで非同期実行）
    if (this.startupSyncWorker) {
      this.startupSyncWorker.startSync(() => this.rebuildIndex({ force: false }));
    }

    // IndexWorker開始
    if (this.indexWorker) {
      this.indexWorker.start();
    }
  }).catch((error) => {
    console.error('[SearchDocsServer] Failed to start DB-dependent workers:', error);
  });

  // FileWatcher開始（DB非依存）
  if (this.watcher) {
    await this.watcher.start();
  }
}
```

### 設計ポイント

1. **非ブロッキング起動**:
   - HTTPサーバーはDB接続を待たずに即座に起動
   - ユーザーは起動遅延を感じない
   - `/health` エンドポイントは即座にアクセス可能

2. **依存関係の明確化**:
   - DB依存のワーカー（IndexWorker、StartupSyncWorker）はDB接続完了後に起動
   - DB非依存のワーカー（FileWatcher）は即座に起動

3. **冪等性**:
   - `connect()` は複数回呼ばれても安全
   - 既に接続済みの場合は何もしない

### テスト結果

✅ search-docsプロジェクト:
```
[DBEngine] Calling resolveConnected(), isReady= true
[DBEngine] resolveConnected() called
[SearchDocsServer] .then() callback started, DB connected, starting DB-dependent workers...
[IndexWorker] Starting (interval: 5000ms, maxConcurrent: 3)
[StartupSyncWorker] Sync completed: 70 documents processed in 781ms
```

✅ karte-io-systemsプロジェクト:
```
[DBEngine] Calling resolveConnected(), isReady= true
[DBEngine] resolveConnected() called
[SearchDocsServer] .then() callback started, DB connected, starting DB-dependent workers...
[IndexWorker] Starting (interval: 5000ms, maxConcurrent: 3)
[IndexWorker] Found 1000 pending requests, processing 620 latest ones
[IndexWorker] Processing 620 index requests
```

✅ エラーなし: 「Not connected to database」エラーは完全に解消

### リリース内容

**Changeset**: `.changeset/fix-db-connection-timing.md`

**公開バージョン**:
- @search-docs/db-engine: 1.0.15 → 1.0.17
- @search-docs/server: 1.1.6 → 1.1.8
- @search-docs/cli: 1.0.17 → 1.0.19
- @search-docs/mcp-server: 1.0.22 → 1.0.24

**コミット**: `96f945c - fix(server): DB接続の非ブロック化とワーカー起動タイミングの修正`

### 解決された問題

✅ DB接続完了前のワーカー起動による「Not connected to database」エラーを根本解決
✅ サーバー起動の高速化（DB接続を待たずにHTTPサーバーが起動）
✅ 依存関係の明確化（DB依存/非依存ワーカーの分離）
✅ 大規模プロジェクトでの安定性向上（620ドキュメントを正常処理）
