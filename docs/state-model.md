# 内部状態モデル

search-docs は複数のプロセスとコンポーネントにまたがる状態を管理している。このドキュメントでは、各状態の定義・遷移条件・依存関係を整理する。

## 状態の全体像

| 層 | 状態 | 値 | 所在 |
|----|------|-----|------|
| MCP | SystemState | NOT_CONFIGURED / RUNNING | MCPサーバプロセス |
| Watcher | writerState | sleeping / claiming / watching | MCPサーバプロセス（in-process WatcherProcess） |
| DB | connectionState | disconnected / connecting / initializing_model / ready / error | MCPサーバプロセス（in-process DBEngine） |
| Worker | IndexWorker | isRunning × isProcessing | MCPサーバプロセス（in-process WatcherProcess） |
| Worker | FileWatcher | 起動 / 停止 | MCPサーバプロセス（in-process WatcherProcess） |
| Worker | StartupSyncWorker | isSyncing | MCPサーバプロセス（in-process WatcherProcess） |
| Embedding | EmbeddingServerProcess | detecting → ready / error | MCPサーバプロセス（in-process） |

## プロセス構成と状態の所在

```
MCPサーバプロセス (stdio)
│  SystemState を管理
│  ServerManager で関連プロジェクトへのURL接続を管理
│
├─ in-process: SearchDocsServer (read-only)
│   connectionState を参照
│   GetStatusResponse を構築
│
├─ in-process: WatcherProcess (write)
│   writerState を管理
│   │
│   ├─ FileWatcher (subscription, master時のみ起動)
│   ├─ IndexWorker (isRunning, isProcessing, master時のみ起動)
│   └─ StartupSyncWorker (isSyncing, master時のみ起動)
│
├─ in-process: DBEngine
│   connectionState を管理
│   └─ subprocess: Pythonワーカー
│
└─ in-process: EmbeddingServerProcess
    外部検出 or ローカルspawn → URL確定
    └─ subprocess: Embeddingサーバ (HTTP, 共有可能)
```

MCPサーバは**SearchDocsServerをin-processで直接保持**します。HTTPデーモンのspawnは不要です。`server start` CLIコマンドは引き続きHTTPサーバとしてSearchDocsServerをexposeする用途で存続します。

## 各状態の詳細

### 1. SystemState（MCP層）

MCPサーバが自身の動作モードを決定するための状態。

```
┌──────────────────┐
│  NOT_CONFIGURED  │  設定ファイルなし
└──────┬───────────┘
       │ init実行
       │ (設定ファイル作成)
       ▼
  ┌─────────┐
  │ RUNNING  │  設定あり、サーバ稼働中（in-process）
  └─────────┘
```

**定義**: `packages/mcp-server/src/state.ts` L14

- **NOT_CONFIGURED**: `ConfigLoader.resolve()` で設定ファイルが見つからない
- **RUNNING**: 設定ファイルが存在し、in-processでSearchDocsServerが稼働中

**判定**: `detectSystemState(cwd)` が起動時に実行。設定ファイルが存在する場合、`createService()` でin-processのSearchDocsServerインスタンスを作成し、RUNNING状態になります。

**変更点（v1.9.0以降）**:
- `CONFIGURED_SERVER_DOWN` 状態を削除（in-process化により不要）
- 設定ファイルが存在すればin-processで起動するため、サーバダウン状態は発生しません

### 2. writerState（Watcher層）

Heartbeatテーブルによる調停で、複数プロセス間から1つだけがmasterとなる。

```
                ┌──────────┐
          ┌─────│ sleeping  │◀────────────────┐
          │     └──────────┘                  │
          │       masterなし                   │ readback失敗
          │       or master期限切れ             │ or master喪失確認
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
- **watching**: master権限を獲得。FileWatcher・IndexWorker・StartupSyncWorkerが起動。`HEARTBEAT_INTERVAL_MS`(20秒)ごとにheartbeat更新。LanceDBの一時的なcommit競合は最大5試行（50→100→200ms、以降200ms上限）で再試行し、更新失敗後も自分がmasterであればwatchingを維持する

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

### 7. EmbeddingServerProcess

**定義**: `packages/server/src/embedding/embedding-server-process.ts`

bin/server.ts が最初に起動するコンポーネント。Embeddingサーバの検出またはローカル起動を行い、確定したURLをDBEngineに渡す。

```
 ┌───────────┐
 │ detecting  │  外部サーバを順に探索
 └─────┬─────┘
       │ 見つかった → external = true
       ├────────────────────▶ ready (external)
       │
       │ 見つからなかった
       ▼
 ┌───────────┐
 │ starting   │  ローカルプロセスをspawn
 └─────┬─────┘
       │ GET /health 成功
       ▼
     ready (local)
```

検出順序:
1. `options.embeddingUrl`（明示指定 or EMBEDDING_URL環境変数）
2. `http://search-docs-embedding:24281`（Docker Composeサービス）
3. `http://host.docker.internal:{port}`（ホスト側サーバ）
4. ローカル起動（`embedding_server.py` をspawn）

## 起動シーケンス

```
時間軸 ──────────────────────────────────────────────────────▶

MCPサーバ起動
│
├─ detectSystemState(cwd)
│    設定ファイル確認
│    → NOT_CONFIGURED または RUNNING準備
│
├─ (RUNNING準備の場合) createService()
│    │
│    ├─ EmbeddingServerProcess.start()
│    │    外部検出 or ローカルspawn → URL確定
│    │
│    ├─ SearchDocsServer作成・起動
│    │    DBEngine.connect(embeddingUrl) [バックグラウンド]
│    │    connectionState: disconnected → connecting
│    │
│    ├─ WatcherProcess作成・起動
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
│    │    (master獲得の場合)
│    │    FileWatcher.start()
│    │    IndexWorker.start()
│    │    StartupSyncWorker.startSync()
│    │
│    └─ ServiceInstances返却
│
├─ SystemState: RUNNING
│
└─ MCPツール利用可能（in-processで即座に実行）
```

**変更点（v1.9.0以降）**:
- HTTPデーモンのspawnが不要に（in-process化）
- healthCheck待ちが不要に（同一プロセス内で直接実行）
- 起動が高速化（プロセス間通信のオーバーヘッドなし）

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
