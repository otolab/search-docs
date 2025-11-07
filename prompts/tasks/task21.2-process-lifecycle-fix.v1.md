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
