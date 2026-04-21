# 内部状態モデル

search-docs は複数のプロセスとコンポーネントにまたがる状態を管理している。このドキュメントでは、各状態の定義・遷移条件・依存関係を整理する。

## 状態の全体像

| 層 | 状態 | 値 | 所在 |
|----|------|-----|------|
| MCP | SystemState | NOT_CONFIGURED / CONFIGURED_SERVER_DOWN / RUNNING | MCPサーバプロセス |
| Watcher | writerState | sleeping / claiming / watching | JSON-RPCサーバプロセス |
| DB | connectionState | disconnected / connecting / initializing_model / ready / error | JSON-RPCサーバプロセス |
| Worker | IndexWorker | isRunning × isProcessing | JSON-RPCサーバプロセス |
| Worker | FileWatcher | 起動 / 停止 | JSON-RPCサーバプロセス |
| Worker | StartupSyncWorker | isSyncing | JSON-RPCサーバプロセス |

## プロセス構成と状態の所在

```
MCPサーバプロセス (stdio)
│  SystemState を管理
│  ServerManager でJSON-RPCサーバへの接続を管理
│
│  ── JSON-RPC ──▶  JSON-RPCサーバプロセス (HTTP)
│                   │
│                   ├─ SearchDocsServer (読み取り専用)
│                   │    connectionState を参照
│                   │    GetStatusResponse を構築
│                   │
│                   ├─ WatcherProcess
│                   │    writerState を管理
│                   │    │
│                   │    ├─ DBEngine (connectionState)
│                   │    ├─ FileWatcher (subscription)
│                   │    ├─ IndexWorker (isRunning, isProcessing)
│                   │    └─ StartupSyncWorker (isSyncing)
│                   │
│                   └─ DBEngine ──spawn──▶ Pythonワーカー (子プロセス)
│                                          └─ Embeddingサーバ (HTTP, 共有可能)
```

MCPサーバとJSON-RPCサーバは別プロセスとして動作する。MCPサーバはJSON-RPCサーバの起動・停止を管理し、JSON-RPC経由で状態を取得する。

## 各状態の詳細

### 1. SystemState（MCP層）

MCPサーバが自身の動作モードを決定するための状態。

```
                      ┌──────────────────┐
                      │  NOT_CONFIGURED  │  設定ファイルなし
                      └──────┬───────────┘
                             │ init実行
                             ▼
┌──────────────────────────────────────────┐
│         CONFIGURED_SERVER_DOWN           │  設定あり、サーバ未起動
│  （自動起動を試みる一時的な状態）          │
└──────────────────┬───────────────────────┘
                   │ healthCheck成功
                   ▼
              ┌─────────┐
              │ RUNNING  │  サーバ稼働中
              └─────────┘
```

**定義**: `packages/mcp-server/src/state.ts` L11

- **NOT_CONFIGURED**: `ConfigLoader.resolve()` で設定ファイルが見つからない
- **CONFIGURED_SERVER_DOWN**: 設定ファイルは存在するが `healthCheck()` が失敗。MCPサーバ起動時に自動起動を試みるため、通常は一時的な状態
- **RUNNING**: `healthCheck()` が成功。各ツールが利用可能

**判定**: `detectSystemState(cwd)` が起動時と `refreshSystemState()` 呼び出し時に実行。

### 2. writerState（Watcher層）

Heartbeatテーブルによる調停で、複数プロセス間から1つだけがmasterとなる。

```
                ┌──────────┐
          ┌─────│ sleeping  │◀────────────────┐
          │     └──────────┘                  │
          │       masterなし                   │ readback失敗
          │       or master期限切れ             │ or heartbeat更新失敗
          ▼                                   │
     ┌──────────┐                        ┌──────────┐
     │ claiming  │──readback成功──────▶│ watching  │
     └──────────┘                        └──────────┘
       jitter待ち → claim書込み             FileWatcher起動
       → readback待ち                      IndexWorker起動
                                           heartbeat定期更新
```

**定義**: `packages/server/src/watcher/watcher-process.ts` L37

- **sleeping**: 他のプロセスがmasterのため待機。`MASTER_CHECK_INTERVAL_MS`(45秒)ごとにmaster確認
- **claiming**: master権限の獲得を試行中。jitter(最大5秒) → claim書込み → readback待ち(4秒)
- **watching**: master権限を獲得。FileWatcher・IndexWorker・StartupSyncWorkerが起動。`HEARTBEAT_INTERVAL_MS`(20秒)ごとにheartbeat更新

**master期限**: `MASTER_TIMEOUT_MS`(120秒)。この間heartbeatが更新されないとmasterは期限切れとみなされる。

### 3. connectionState（DB層）

DBEngine（TypeScript）がPythonワーカープロセスの接続状態を管理する。

```
 ┌──────────────┐   connect()    ┌────────────┐
 │ disconnected  │──────────────▶│ connecting  │
 └──────────────┘                └─────┬──────┘
       ▲                               │ ping成功
       │ disconnect()                  ▼
       │                     ┌───────────────────┐
       ├─────────────────────│ initializing_model │
       │                     └────────┬──────────┘
       │                              │ initModel成功
       │                              ▼
       │                        ┌─────────┐
       ├────────────────────────│  ready   │
       │                        └─────────┘
       │
       │                        ┌─────────┐
       └────────────────────────│  error   │
                                └─────────┘
                           接続失敗 or モデル初期化失敗
```

**定義**: `packages/db-engine/src/typescript/index.ts` L217

- **disconnected**: 初期状態。Pythonワーカー未起動
- **connecting**: Pythonワーカーを起動し、pingに応答するまで待機（最大60秒）
- **initializing_model**: Ruri埋め込みモデルの初期化中
- **ready**: クエリ受付可能。`waitForConnection()` のPromiseが解決される
- **error**: 接続またはモデル初期化に失敗。`waitForConnection()` のPromiseが拒否される

**参照**: `SearchDocsServer.checkDatabaseConnection()` がリクエストごとに確認し、未準備時はエラーメッセージを返す。

### 4. IndexWorker

**定義**: `packages/server/src/worker/index-worker.ts` L27-28

- **isRunning**: ワーカーが起動中か（定期実行タイマーが動作中）
- **isProcessing**: 現在リクエストを処理中か（処理中は次の定期実行をスキップ）

WatcherProcessが `watching` に遷移すると `start()` で起動、`sleeping` に遷移すると `stop()` で停止。

### 5. FileWatcher

**定義**: `packages/server/src/discovery/file-watcher.ts` L28

`@parcel/watcher` のsubscriptionの有無で起動/停止を表す。WatcherProcessのwriterStateと連動。

### 6. StartupSyncWorker

**定義**: `packages/server/src/worker/startup-sync-worker.ts` L17-18

- **isSyncing**: 初回起動時のファイルスキャン・インデックスリクエスト作成が実行中か

WatcherProcessが `watching` に遷移した直後に1回だけ実行される。

## 起動シーケンス

```
時間軸 ──────────────────────────────────────────────────────▶

MCPサーバ起動
│
├─ detectSystemState()
│    設定ファイル確認 → healthCheck
│    → CONFIGURED_SERVER_DOWN
│
├─ serverManager.startServer()
│    CLI経由でJSON-RPCサーバをspawn
│    healthCheck待ち（最大30秒）
│
│    JSON-RPCサーバ起動
│    │
│    ├─ SearchDocsServer.start()
│    │    DBEngine.connect() [バックグラウンド]
│    │    connectionState: disconnected → connecting
│    │
│    ├─ WatcherProcess.start()
│    │    DBEngine.waitForConnection() 待ち
│    │
│    │    ... Pythonワーカー起動 ...
│    │    connectionState: connecting → initializing_model → ready
│    │
│    │    WatcherProcess: DB接続完了
│    │    writerState: sleeping
│    │    checkAndClaimMaster()
│    │    writerState: sleeping → claiming → watching
│    │
│    │    FileWatcher.start()
│    │    IndexWorker.start()
│    │    StartupSyncWorker.startSync()
│    │
│    └─ healthCheck応答可能に
│
├─ detectSystemState() 再実行
│    → RUNNING
│
└─ MCPツール利用可能
```

## 状態公開API

`GetStatusResponse`（`packages/types/src/api.ts` L131）を通じて、JSON-RPCサーバが内部状態を公開する。

```typescript
{
  server: {
    version, uptime, pid, syncing,  // SearchDocsServer
    requests: { total, search, ... }
  },
  database: {
    connectionState,                 // DBEngine.connectionState
    connectionError?
  },
  index: {
    totalDocuments, totalSections,   // DBEngine.getStats()
    dirtyCount
  },
  worker: {
    running,                         // WatcherProcess → IndexWorker.isRunning
    processing, queue                // DBEngine.countIndexRequests()
  },
  watcher?: {
    state,                           // WatcherProcess.writerState
    writerId                         // WatcherProcess.writerId
  }
}
```

MCPツール（`get_system_status`, `index_status`）はこのAPIを呼び出して状態を表示する。
