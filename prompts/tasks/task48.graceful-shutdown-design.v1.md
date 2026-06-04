# task48: MCPサーバの安全な停止プロセス設計

## 背景

MCPサーバのkillシグナルに対する応答性が悪い。
原因は「停止プロセス」が設計されておらず、「終わるのを待つ」消極的な実装になっていること。

## 急に殺して何が壊れるか

調査の結果、**ほとんどのものは即killしても壊れない**。

| 項目 | 壊れるか | 理由 |
|---|---|---|
| LanceDB | 壊れない | MVCCで不完全な書き込みは破棄される |
| writer heartbeat | 壊れない | 120秒後に期限切れで自動復旧 |
| PIDファイル | 壊れない | staleチェックがある |
| Embeddingサーバ | 壊れない | healthCheckで再利用される |
| FileWatcher | 壊れない | ロックなし、プロセス終了で解放 |
| **DocumentStorage** | **壊れる** | `fs.writeFile()` 途中で死ぬと不完全なJSONが残る |

### 唯一の問題: FileStorage.save()の非atomic書き込み

```typescript
// packages/storage/src/file-storage.ts:47
await fs.writeFile(filePath, JSON.stringify(docWithHash, null, 2), 'utf-8');
```

途中でkillされると壊れたJSONが残り、次回 `JSON.parse()` で失敗する。
これはgraceful shutdown以前に、**atomic write（tmp→rename）で根本解決すべき問題**。

### FileStorageに書き込むのは誰か

IndexWorker（WatcherProcess内）のみ。直接ではなく、IndexWorker.processRequest() → storage.get() で読む側。

実際の書き込みパスを確認:
- `storage.save()` を呼んでいるのはWatcherProcessの中のファイル変更検知 → indexRequest作成のフロー
- **IndexWorker自体はstorageに書き込まない**（LanceDBに書き込む）

→ WatcherProcessのファイル変更検知フロー内で `storage.save()` が呼ばれる箇所がatomic writeの対象。

## 停止プロセスの設計

### 前提

- 子プロセス（Python worker, Embedding server）は親が死ねばinitに回収される。PID管理は不要
- 親プロセスのPIDファイルはJSON-RPCサーバのみ使用（既存の仕組みで十分）
- LanceDBはMVCCで書き込み途中の中断に耐える
- **守るべきものはFileStorageの書き込みだけ**

### 原則

1. **FileStorageのatomic writeを実装する** — これが入れば即killでも壊れない
2. **停止は速やかに行う** — 守るべきものがないなら、さっさと死ぬ
3. **全体のタイムアウトを設ける** — 何かが詰まっても必ず終了する

### 停止シーケンス

```
シグナル受信 (SIGINT/SIGTERM)
  │
  ├─ 1. IndexWorkerを停止（新規処理を開始しない）
  │     isRunning = false, clearInterval
  │
  ├─ 2. 処理中の書き込みがあれば完了を待つ（最大2秒）
  │     IndexWorker.isProcessing を監視
  │     ※ FileStorageがatomic writeなら、この待機自体が不要になる
  │
  ├─ 3. 残りのリソースを解放
  │     タイマー全クリア、FileWatcher停止、子プロセスkill
  │
  └─ process.exit()

全体タイムアウト: 3秒。超過したらprocess.exit(1)。
```

### 実装方針

**Phase 1: FileStorageのatomic write**
- `fs.writeFile(path, data)` → `fs.writeFile(path + '.tmp', data)` + `fs.rename(path + '.tmp', path)`
- rename はPOSIXでatomic。途中でkillされても `.tmp` ファイルが残るだけで既存データは壊れない
- `.tmp` ファイルは次回起動時に無視する（or 削除する）

**Phase 2: シグナルハンドラの改善**
- `void cleanup()` → `await cleanup()` + `process.exit()`
- 全体タイムアウト: `setTimeout(() => process.exit(1), 3000)`
- IndexWorkerの処理完了を待つ（atomic write後はこの待機を省略可能）

**Phase 3: stopServiceの簡素化**
- mastershipリリース（releaseWriter）: 不要にする。120秒で自動復旧する
- 子プロセスの停止: `worker.kill()` で十分（親が死ねば子も回収される）
- EmbeddingServerの5秒タイムアウト: 不要にする
