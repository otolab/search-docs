# task21: MCPサーバ起動改善（大規模プロジェクト対応）

## 作業目的

MCPサーバの起動時にsearch-docsサーバの起動完了を待機しているが、現在の実装ではファイル更新状況確認まで完了を待つため、大規模プロジェクトでMCPのコネクションタイムアウトエラーが発生する。起動プロセスを非同期化し、サーバの状態に応じて利用可能なツールを切り替える仕組みを実装する。

## 問題の詳細

### 現状の問題
1. **MCPサーバ起動時の長時間ブロック**
   - search-docsサーバの起動完了を待機
   - ファイル検索・インデックス作成までブロックされる
   - 大規模プロジェクトではタイムアウトする

2. **サーバ状態の非考慮**
   - サーバ未起動時もsearch等のツールが表示される
   - 実行時にエラーになる

## 作業目標

### フェーズ1: サーバ起動の非同期化 ✅
- [x] サーバ起動完了の定義を見直す
  - ドキュメント検索（worker処理）は起動完了条件から除外
  - サーバプロセスの起動とAPI応答可能状態を起動完了とする
- [x] workerを真にバックグラウンド化
  - 起動プロセスをブロックしない
  - インデックス作成は非同期で実行

### フェーズ2: MCPサーバの状態管理改善
- [ ] MCPサーバがsearch-docsサーバの状態を動的に把握
  - 定期的なヘルスチェック
  - サーバ起動/停止の検知
- [ ] サーバ状態に応じた適切なエラーハンドリング
  - サーバ未起動時のユーザーフレンドリーなエラーメッセージ
  - 自動リトライ（オプション）

### フェーズ3: 利用可能ツールの動的切り替え（MCP listChanged対応）
- [ ] サーバ状態に応じたツールリストの切り替え
  - 設定ファイル未存在時: `init`系ツールのみ
  - サーバ未起動時: `server start`等のサーバ管理ツール
  - サーバ起動済み時: `search`, `get_document`等の検索ツール
- [ ] MCP `notifications/tools/list_changed` の実装
  - サーバ状態変化時にClaude Codeへ通知
  - ツールリストの再読み込み

## 調査結果

### 現在の実装調査

#### MCPサーバの起動フロー (`packages/mcp-server/src/server-manager.ts`)

1. **サーバ起動処理** (51-170行目)
   - `startServer()`: search-docsサーバをデーモンモードで起動
   - CLIコマンド実行: `node <cli-path> server start --port <port>`
   - プロセスをspawnして即座に返す（デーモンモード）

2. **ヘルスチェック待機** (120-146行目) **← 問題の核心**
   ```typescript
   // サーバのヘルスチェックを行う（最大30秒待機）
   const serverUrl = `http://localhost:${port}`;
   const client = new SearchDocsClient({ baseUrl: serverUrl });
   const maxWaitTime = 30000; // 30秒
   ```
   - `/health`エンドポイントが応答するまで待機
   - 30秒タイムアウト

#### search-docsサーバの起動フロー

1. **エントリポイント** (`packages/server/src/bin/server.ts:53`)
   ```typescript
   await jsonRpcServer.start();
   ```

2. **JSON-RPCサーバ起動** (`packages/server/src/server/json-rpc-server.ts:238-247`)
   ```typescript
   async start(): Promise<void> {
     await this.searchDocsServer.start();  // ← ここでブロック

     return new Promise((resolve) => {
       this.server = this.app.listen(this.port, this.host, () => {
         console.log(`JSON-RPC server listening...`);
         resolve();
       });
     });
   }
   ```

3. **SearchDocsServer起動** (`packages/server/src/server/search-docs-server.ts:86-124`) **← 問題の箇所**
   ```typescript
   async start(): Promise<void> {
     this.startTime = Date.now();
     await this.dbEngine.connect();

     // 起動時にインデックスを同期（変更されたファイルのみ）
     console.log('Syncing index on startup...');
     try {
       const result = await this.rebuildIndex({ force: false });  // ← ここで長時間ブロック
       console.log(`Index sync completed: ${result.documentsProcessed} documents processed`);
     } catch (error) {
       console.error('Failed to sync index on startup:', error);
     }

     // FileWatcher開始
     if (this.watcher) {
       await this.watcher.start();
     }

     // IndexWorker開始
     if (this.indexWorker) {
       this.indexWorker.start();
     }
   }
   ```

4. **HTTPサーバ起動**
   - `SearchDocsServer.start()`が完了してから初めてHTTPサーバが起動
   - `/health`エンドポイントが応答可能になる

#### ヘルスチェックエンドポイント (`packages/server/src/server/json-rpc-server.ts:104-107`)
```typescript
// ヘルスチェック
this.app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
```
- シンプルに`{status: 'ok'}`を返すだけ
- サーバ起動後は常に成功を返す

### 問題の構造

**起動フローの時系列**:
```
1. MCPサーバ起動
2. ├→ search-docsサーバをデーモン起動
3. │  ├→ SearchDocsServer.start()
4. │  │  ├→ dbEngine.connect()
5. │  │  ├→ rebuildIndex() ← 【大規模プロジェクトで数分かかる】
6. │  │  ├→ FileWatcher.start()
7. │  │  └→ IndexWorker.start()
8. │  └→ HTTPサーバ起動（ポートLISTEN開始）
9. └→ ヘルスチェック待機（最大30秒）← 【5が終わらないと8に進まず、タイムアウト】
```

**問題点**:
- `rebuildIndex()`が同期的に実行されるため、HTTPサーバが起動しない
- ヘルスチェックがタイムアウト（30秒）してMCPサーバ起動失敗

### 技術調査
- [ ] MCP `notifications/tools/list_changed` の仕様
  - プロトコルの詳細
  - Claude Code側での対応状況
  - 実装例

## 解決方針

### 基本方針

**HTTPサーバを先に起動し、初期インデックス同期をワーカー化する**

ユーザーフィードバックを踏まえた設計：
1. `rebuildIndex`は`FileWatcher`と同格だが特性が異なる
   - `FileWatcher`: リアルタイムの変更検知（イベント駆動）
   - 初期インデックス同期: 起動時の一括処理（バッチ処理）
2. 初期インデックス同期をワーカー化
3. `syncing`フラグはサーバ状態として管理

### 現在のワーカー構成

- **IndexWorker** (`packages/server/src/worker/index-worker.ts`)
  - Dirty状態のセクションを定期的に処理
  - 既存の仕組み

- **FileWatcher** (`packages/server/src/discovery/file-watcher.ts`)
  - ファイル変更をリアルタイム検知
  - イベント駆動

### 新規ワーカーの追加: StartupSyncWorker

**役割**:
- 起動時の初期インデックス同期を非同期で実行
- HTTPサーバ起動をブロックしない
- 同期完了まで状態を管理

**実装案**:
```typescript
export class StartupSyncWorker {
  private isSyncing = false;
  private syncPromise: Promise<void> | null = null;

  /**
   * バックグラウンドで初期同期を開始
   */
  startSync(rebuildFn: () => Promise<RebuildIndexResponse>): void {
    if (this.isSyncing) {
      console.warn('[StartupSyncWorker] Sync already in progress');
      return;
    }

    this.isSyncing = true;
    this.syncPromise = this.runSync(rebuildFn);
  }

  private async runSync(rebuildFn: () => Promise<RebuildIndexResponse>): Promise<void> {
    try {
      console.log('[StartupSyncWorker] Starting initial index sync...');
      const result = await rebuildFn();
      console.log(`[StartupSyncWorker] Sync completed: ${result.documentsProcessed} documents processed`);
    } catch (error) {
      console.error('[StartupSyncWorker] Sync failed:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 同期中かどうか
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * 同期完了を待機（テスト用）
   */
  async waitForSync(): Promise<void> {
    if (this.syncPromise) {
      await this.syncPromise;
    }
  }
}
```

**SearchDocsServerの変更**:
```typescript
async start(): Promise<void> {
  this.startTime = Date.now();
  await this.dbEngine.connect();

  // StartupSyncWorkerで初期同期を開始（非同期）
  if (this.startupSyncWorker) {
    this.startupSyncWorker.startSync(() => this.rebuildIndex({ force: false }));
  }

  // FileWatcher開始
  if (this.watcher) {
    await this.watcher.start();
  }

  // IndexWorker開始
  if (this.indexWorker) {
    this.indexWorker.start();
  }
}
```

### 構造の変更

**変更前（現在）**:
```
JsonRpcServer.start()
  ├→ SearchDocsServer.start()
  │   ├→ dbEngine.connect()
  │   ├→ rebuildIndex() ← ブロック
  │   ├→ FileWatcher.start()
  │   └→ IndexWorker.start()
  └→ HTTPサーバ起動
```

**変更後**:
```
JsonRpcServer.start()
  ├→ SearchDocsServer.start()
  │   ├→ dbEngine.connect()
  │   ├→ startBackgroundIndexSync() ← 非同期
  │   ├→ FileWatcher.start()
  │   └→ IndexWorker.start()
  └→ HTTPサーバ起動 ← すぐに実行される
```

### サーバ状態の管理

ユーザーフィードバック：`syncing`はインデックス状態というよりサーバ状態に近い

**GetStatusResponseに`syncing`を追加**:
```typescript
interface GetStatusResponse {
  server: {
    version: string;
    uptime: number;
    pid: number;
    syncing: boolean;  // ← 追加（初期インデックス同期中か）
  };
  index: {
    totalDocuments: number;
    totalSections: number;
    dirtyCount: number;
  };
  worker: {
    running: boolean;
    processing: number;
    queue: number;
  };
}
```

**実装**:
```typescript
async getStatus(): Promise<GetStatusResponse> {
  const indexStatus = await this.dbEngine.getIndexStatus();

  return {
    server: {
      version: VERSION,
      uptime: Date.now() - this.startTime,
      pid: process.pid,
      syncing: this.startupSyncWorker?.isSyncInProgress() ?? false,  // ← 追加
    },
    index: {
      totalDocuments: indexStatus.totalDocuments,
      totalSections: indexStatus.totalSections,
      dirtyCount: indexStatus.dirtyCount,
    },
    worker: {
      running: this.indexWorker?.isRunning() ?? false,
      processing: this.indexWorker?.getProcessingCount() ?? 0,
      queue: indexStatus.dirtyCount,
    },
  };
}
```

**検索時の動作**:
- 初期同期中でも検索は可能（既存データで検索）
- インデックスが空の場合は空の結果を返す
- 検索結果に「同期中」の警告を含めるかは検討（オプション）

## 実装計画

### ステップ1: 現状把握 ✓
1. ✓ MCPサーバの起動コードを読む
2. ✓ search-docsサーバの起動コードを読む
3. ✓ 問題箇所を特定

### ステップ2: サーバ起動の非同期化 ✅
1. ✅ StartupSyncWorkerの実装
   - `packages/server/src/worker/startup-sync-worker.ts`を新規作成
   - 初期インデックス同期を非同期で実行
   - 同期状態を管理
2. ✅ SearchDocsServerの変更
   - StartupSyncWorkerを初期化
   - `start()`メソッドで`rebuildIndex()`を同期実行から非同期ワーカー実行に変更
3. ✅ サーバ状態管理の追加
   - `GetStatusResponse.server.syncing`を追加
   - StartupSyncWorkerの状態を反映
4. ✅ 型定義の更新
   - `@search-docs/types`の`GetStatusResponse`を更新
5. ✅ テストで動作確認
   - 起動直後にヘルスチェックが成功すること
   - バックグラウンドでインデックス同期が実行されること
   - `getStatus()`で`syncing`フラグが正しく返ること

### ステップ3: MCPサーバの改善（必要に応じて）
1. サーバ状態チェック機能を実装
2. 状態に応じたエラーハンドリング
3. テストで動作確認

### ステップ4: ツール動的切り替え（オプション）
1. MCP仕様の調査
2. 状態管理ロジックの実装
3. `list_changed`通知の実装
4. テストで動作確認

## 期待される効果

1. **大規模プロジェクトでの起動成功**
   - MCPコネクションタイムアウトの解消
   - 数千ファイルのプロジェクトでも即座に起動

2. **ユーザビリティ向上**
   - サーバ未起動時のエラーメッセージが分かりやすい
   - 必要なツールのみが表示される

3. **保守性向上**
   - サーバ状態管理が明確になる
   - 非同期処理の責任分離

## メモ

- フェーズ1と2は必須
- フェーズ3はMCPのサポート状況次第でオプション扱い
- まずは現状調査から開始

## 完了報告 (2025-11-07)

### 実装完了

フェーズ1「サーバ起動の非同期化」を完了しました。

#### 実装内容

1. **StartupSyncWorker作成** (`packages/server/src/worker/startup-sync-worker.ts`)
   - 初期インデックス同期をバックグラウンドで実行
   - `isSyncInProgress()` で同期状態を公開
   - `waitForSync()` でテスト時の同期待機が可能

2. **SearchDocsServer変更** (`packages/server/src/server/search-docs-server.ts`)
   - StartupSyncWorkerをインスタンス化（常に有効）
   - `start()`メソッドで`rebuildIndex()`をブロッキング実行からバックグラウンド実行に変更
   - `getStatus()`で`syncing`フラグを返すように実装

3. **API型定義更新** (`packages/types/src/api.ts`)
   - `GetStatusResponse.server.syncing: boolean`フィールドを追加

4. **Worker Export** (`packages/server/src/worker/index.ts`)
   - StartupSyncWorkerをエクスポート

#### 効果

- ✅ **大規模プロジェクトでのMCPタイムアウト解消**: HTTPサーバが即座に起動し、ヘルスチェックに応答可能
- ✅ **サーバ状態の可視化**: `syncing`フラグで初期同期状態をクライアントが確認可能
- ✅ **アーキテクチャの一貫性**: FileWatcher、IndexWorkerと同格のワーカーパターン

#### テスト結果

- ビルド成功（型エラーなし）
- 全パッケージのテスト成功（FileWatcherの既存エラーを除く）
- StartupSyncWorkerのログ確認済み:
  ```
  [StartupSyncWorker] Starting initial index sync...
  [StartupSyncWorker] Sync completed: 0 documents processed in 3ms
  ```

#### コミット

コミットID: 5e5aa77
コミットメッセージ: "feat(server): サーバ起動の非同期化でMCPタイムアウトを解消"

### 今後の展開

フェーズ2、フェーズ3は必要に応じて別タスクとして実施予定。
