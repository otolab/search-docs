# Task 8: インデックス状態管理システムの仕様と実装

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

**作成日**: 2025-10-30
**タスク番号**: task8
**バージョン**: v2（IndexRequestテーブル導入版）
**前提**: Task 6（設計と実装の乖離調査）
**状態**: Phase 1-7 完了 ✅

## 背景

現在の実装では、インデックス更新時に古いindexを即座に削除してから新しいindexを作成しているため、以下の問題がある：

1. **検索不能期間の発生**: インデックス作成中は検索ができない
2. **将来の拡張性**: summary生成など時間のかかる処理に対応できない
3. **不安定な状態での動作不可**: 処理中にファイルが更新されると整合性が崩れる

## 要求事項

### 前提条件
- インデックス作成に時間がかかる（将来的にsummary生成など）
- 時間差が問題になる

### 目標
1. storage（文書）、index（検索）、実体ファイルの3者同期
2. 不完全な同期状態をできるだけ減らす
3. 不安定な状態でも必要十分に動作する
4. 検索可能な状態を常に維持する
5. 検索時にindex状態でフィルタ可能

## アーキテクチャ概要

### 主要コンポーネント

1. **DocumentStorage** - 文書の永続化
2. **IndexRequest** - インデックス作成要求の管理（新設）
3. **Section** - 完成したインデックス
4. **IndexWorker** - バックグラウンドでインデックス作成

### データフロー

```
ファイル変更
  ↓
Storage更新 + IndexRequest作成
  ↓
IndexWorker が最新リクエストのみ処理
  ↓
Section作成 + 古いSection削除
  ↓
IndexRequest完了マーク
```

## データモデル

### 1. IndexRequest（新設）

**役割**: インデックス作成要求を管理

```typescript
interface IndexRequest {
  id: string;                    // UUID
  document_path: string;         // ファイルパス
  document_hash: string;         // このバージョンのハッシュ
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  created_at: Date;              // 要求作成日時
  started_at?: Date;             // 処理開始日時
  completed_at?: Date;           // 処理完了日時
  error?: string;                // エラーメッセージ
}
```

**ステータス遷移**:
```
pending → processing → completed
                    → failed
        → skipped（より新しいリクエストがある場合）
```

**PyArrowスキーマ**:
```python
IndexRequestSchema = pa.schema([
    ("id", pa.string()),
    ("document_path", pa.string()),
    ("document_hash", pa.string()),
    ("status", pa.string()),  # 'pending', 'processing', 'completed', 'failed', 'skipped'
    ("created_at", pa.timestamp('ms')),
    ("started_at", pa.timestamp('ms')),
    ("completed_at", pa.timestamp('ms')),
    ("error", pa.string()),
])
```

### 2. Section（既存、変更なし）

**役割**: 完成したインデックス

```typescript
interface Section {
  id: string;
  document_path: string;
  heading: string;
  depth: number;
  content: string;
  token_count: number;
  vector: Float32Array;
  parent_id: string | null;
  order: number;

  // バージョン情報
  document_hash: string;         // このindexが基づいている文書のハッシュ
  created_at: Date;
  updated_at: Date;
}
```

### 3. Document（既存、変更なし）

**役割**: 文書の永続化

```typescript
interface Document {
  path: string;
  title: string;
  content: string;
  metadata: {
    fileHash: string;            // 最新の文書ハッシュ
    createdAt: Date;
    updatedAt: Date;
  };
}
```

## 処理フロー詳細

### 1. ファイル更新時

```typescript
async onFileChange(path: string) {
  // 1. ファイルを読み込み
  const content = await fs.readFile(path, 'utf-8');

  // 2. ハッシュを計算
  const hash = createHash('sha256').update(content).digest('hex');

  // 3. storageに保存
  const document: Document = {
    path,
    title: extractTitle(content),
    content,
    metadata: {
      fileHash: hash,
      updatedAt: new Date()
    }
  };
  await storage.save(path, document);

  // 4. IndexRequestを作成
  const request: IndexRequest = {
    id: uuid(),
    document_path: path,
    document_hash: hash,
    status: 'pending',
    created_at: new Date()
  };
  await indexRequestTable.insert(request);

  console.log(`IndexRequest created: ${path} (${hash.slice(0, 8)})`);
}
```

**重要**: debounce処理は不要。すべてのファイル変更でIndexRequestを作成する。

### 2. IndexWorker（バックグラウンド処理）

#### 2.1 ワーカーのメインループ

```typescript
class IndexWorker {
  private interval: number = 5000;  // 5秒
  private running: boolean = false;

  async start() {
    this.running = true;
    console.log('IndexWorker started');

    while (this.running) {
      try {
        await this.processNextRequests();
      } catch (error) {
        console.error('IndexWorker error:', error);
      }

      await sleep(this.interval);
    }
  }

  async stop() {
    this.running = false;
    console.log('IndexWorker stopped');
  }

  async processNextRequests() {
    // 1. 処理すべきリクエストを取得
    const requests = await this.getNextRequests();

    if (requests.length === 0) {
      return;
    }

    console.log(`Processing ${requests.length} index requests`);

    // 2. 1件ずつ処理
    for (const request of requests) {
      await this.processRequest(request);
    }
  }
}
```

#### 2.2 次のリクエストを取得

```typescript
async getNextRequests(): Promise<IndexRequest[]> {
  // 1. すべてのpendingリクエストを取得
  const allPending = await indexRequestTable.findAll({
    status: 'pending',
    order: 'created_at ASC'
  });

  if (allPending.length === 0) {
    return [];
  }

  // 2. document_path毎にグループ化
  const grouped = new Map<string, IndexRequest[]>();
  for (const request of allPending) {
    if (!grouped.has(request.document_path)) {
      grouped.set(request.document_path, []);
    }
    grouped.get(request.document_path)!.push(request);
  }

  // 3. 各グループで最新のもののみ抽出
  const latest: IndexRequest[] = [];
  for (const [path, requests] of grouped) {
    // created_at降順でソートして最新を取得
    requests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    latest.push(requests[0]);
  }

  console.log(`Found ${allPending.length} pending requests, processing ${latest.length} latest ones`);

  return latest;
}
```

#### 2.3 リクエストを処理

```typescript
async processRequest(request: IndexRequest): Promise<void> {
  console.log(`Processing: ${request.document_path} (${request.document_hash.slice(0, 8)})`);

  try {
    // 1. ステータスを更新
    await indexRequestTable.update(request.id, {
      status: 'processing',
      started_at: new Date()
    });

    // 2. 同じdocument_pathの古いpendingリクエストをskip
    await indexRequestTable.updateMany({
      document_path: request.document_path,
      status: 'pending',
      created_at: { $lt: request.created_at }
    }, {
      status: 'skipped',
      completed_at: new Date()
    });

    // 3. storageから文書を取得
    const doc = await storage.get(request.document_path);
    if (!doc) {
      throw new Error(`Document not found: ${request.document_path}`);
    }

    // 4. ハッシュが一致するか確認
    if (doc.metadata.fileHash !== request.document_hash) {
      // 処理中に更新されたので、このリクエストは古い
      console.log(`Document updated during processing: ${request.document_path}`);
      await indexRequestTable.update(request.id, {
        status: 'completed',
        completed_at: new Date()
      });
      return;
    }

    // 5. 既存の同じハッシュのindexがあるかチェック
    const existingSections = await sectionTable.findByPathAndHash(
      request.document_path,
      request.document_hash
    );

    if (existingSections.length > 0) {
      console.log(`Index already exists for ${request.document_path} (${request.document_hash.slice(0, 8)})`);

      // 既に存在する場合は、古いindexだけ削除
      await sectionTable.deleteByPathExceptHash(
        request.document_path,
        request.document_hash
      );

      await indexRequestTable.update(request.id, {
        status: 'completed',
        completed_at: new Date()
      });
      return;
    }

    // 6. インデックスを生成
    console.log(`Generating index for ${request.document_path}`);
    const sections = await this.splitter.split(
      doc.content,
      request.document_path,
      request.document_hash
    );

    // 7. 新しいindexを保存
    for (const section of sections) {
      await sectionTable.insert(section);
    }
    console.log(`Created ${sections.length} sections for ${request.document_path}`);

    // 8. 古いindexを削除
    const deleted = await sectionTable.deleteByPathExceptHash(
      request.document_path,
      request.document_hash
    );
    console.log(`Deleted ${deleted} old sections for ${request.document_path}`);

    // 9. リクエストを完了マーク
    await indexRequestTable.update(request.id, {
      status: 'completed',
      completed_at: new Date()
    });

    console.log(`Completed: ${request.document_path} (${request.document_hash.slice(0, 8)})`);

  } catch (error) {
    console.error(`Failed to process ${request.document_path}:`, error);

    await indexRequestTable.update(request.id, {
      status: 'failed',
      completed_at: new Date(),
      error: error.message
    });
  }
}
```

### 3. 検索時の処理

#### 3.1 検索オプション

```typescript
interface SearchOptions {
  query: string;
  limit?: number;
  depth?: number | number[];
  indexStatus?: 'all' | 'latest_only' | 'completed_only';
  // all: すべて（デフォルト）
  // latest_only: 更新中でないもののみ
  // completed_only: 完成したindexのみ（latest_onlyと同義）
}
```

#### 3.2 検索処理

```typescript
async search(options: SearchOptions): Promise<SearchResult[]> {
  // 1. 基本検索オプション
  const searchOpts = {
    limit: options.limit || 10,
    depth: options.depth
  };

  // 2. indexStatusによるフィルタ
  if (options.indexStatus === 'latest_only' || options.indexStatus === 'completed_only') {
    // pending/processingのリクエストがあるdocument_pathを除外
    const pathsWithPending = await indexRequestTable.getPathsWithStatus([
      'pending',
      'processing'
    ]);

    if (pathsWithPending.length > 0) {
      searchOpts.excludePaths = pathsWithPending;
    }
  }

  // 3. Vector検索を実行
  const sections = await dbEngine.search(options.query, searchOpts);

  // 4. 各結果に状態情報を付与
  const results = await Promise.all(sections.map(async section => {
    const status = await this.computeIndexStatus(section);

    return {
      ...section,
      indexStatus: status.status,
      isLatest: status.isLatest,
      hasPendingUpdate: status.hasPendingUpdate
    };
  }));

  return results;
}
```

#### 3.3 Index状態の計算

```typescript
async computeIndexStatus(section: Section): Promise<{
  status: 'latest' | 'outdated' | 'updating';
  isLatest: boolean;
  hasPendingUpdate: boolean;
}> {
  // 1. storageから最新のdocument_hashを取得
  const doc = await storage.get(section.document_path);
  if (!doc) {
    return {
      status: 'outdated',
      isLatest: false,
      hasPendingUpdate: false
    };
  }

  const isLatest = section.document_hash === doc.metadata.fileHash;

  // 2. pending/processingのリクエストがあるか確認
  const pendingRequests = await indexRequestTable.findAll({
    document_path: section.document_path,
    status: ['pending', 'processing']
  });

  const hasPendingUpdate = pendingRequests.length > 0;

  // 3. ステータスを判定
  let status: 'latest' | 'outdated' | 'updating';
  if (hasPendingUpdate) {
    status = 'updating';
  } else if (isLatest) {
    status = 'latest';
  } else {
    status = 'outdated';  // 通常ありえない（古いindexは削除されるため）
  }

  return { status, isLatest, hasPendingUpdate };
}
```

### 4. 検索結果の表示

#### TypeScript型定義

```typescript
interface SearchResult extends Section {
  score: number;
  indexStatus: 'latest' | 'outdated' | 'updating';
  isLatest: boolean;
  hasPendingUpdate: boolean;
}
```

#### CLI出力（text形式）

```
検索結果: "Vector検索" (3件)

1. docs/architecture.md - Vector検索エンジン (スコア: 0.95) [最新]
   LanceDBベースのVector検索エンジンです...

2. README.md - 主な機能 (スコア: 0.89) [更新中]
   文書全体とセクションごとに対してVector検索を実行...

3. docs/data-model.md - 検索機能 (スコア: 0.85) [最新]
   Vector類似度検索...
```

#### JSON出力

```json
{
  "query": "Vector検索",
  "total": 3,
  "results": [
    {
      "documentPath": "docs/architecture.md",
      "heading": "Vector検索エンジン",
      "score": 0.95,
      "indexStatus": "latest",
      "isLatest": true,
      "hasPendingUpdate": false
    },
    {
      "documentPath": "README.md",
      "heading": "主な機能",
      "score": 0.89,
      "indexStatus": "updating",
      "isLatest": false,
      "hasPendingUpdate": true
    }
  ]
}
```

## DBエンジンAPI

### 既存API（変更なし）

- `addSection(section: Section): Promise<void>`
- `search(query: string, options): Promise<Section[]>`
- `deleteSectionsByPath(path: string): Promise<{ deleted: number }>`

### 新規API（IndexRequest用）

```typescript
// IndexRequestテーブル操作
async createIndexRequest(request: Omit<IndexRequest, 'id'>): Promise<IndexRequest>
async findIndexRequests(filter: IndexRequestFilter): Promise<IndexRequest[]>
async updateIndexRequest(id: string, updates: Partial<IndexRequest>): Promise<void>
async updateManyIndexRequests(filter: IndexRequestFilter, updates: Partial<IndexRequest>): Promise<{ updated: number }>
async getPathsWithStatus(statuses: IndexRequest['status'][]): Promise<string[]>

// Sectionテーブル操作（追加）
async findSectionsByPathAndHash(path: string, hash: string): Promise<Section[]>
async deleteSectionsByPathExceptHash(path: string, hash: string): Promise<{ deleted: number }>
```

### IndexRequestFilter

```typescript
interface IndexRequestFilter {
  document_path?: string;
  document_hash?: string;
  status?: IndexRequest['status'] | IndexRequest['status'][];
  created_at?: { $lt?: Date; $gt?: Date };
  order?: 'created_at ASC' | 'created_at DESC';
}
```

## 実装計画

### Phase 1: IndexRequestテーブルの実装（3時間） ✅

**目標**: IndexRequestテーブルとCRUD操作を実装

#### 1.1 Pythonスキーマ定義（30分）
- [x] `packages/db-engine/src/python/schemas.py`にIndexRequestSchemaを追加
- [x] LanceDBテーブル作成処理

#### 1.2 Python CRUD操作（1時間）
- [x] `create_index_request()`
- [x] `find_index_requests()`
- [x] `update_index_request()`
- [x] `update_many_index_requests()`
- [x] `get_paths_with_status()`

#### 1.3 TypeScript APIラッパー（1時間）
- [x] `packages/db-engine/src/typescript/index.ts`にAPI追加
- [x] JSON-RPC経由でPython関数を呼び出し

#### 1.4 テスト（30分）
- [x] IndexRequest CRUD操作のテスト
- [x] フィルタ条件のテスト

### Phase 2: Section関連APIの拡張（2時間） ✅

**目標**: document_hashによるフィルタ・削除機能

#### 2.1 Python実装（1時間）
- [x] `find_sections_by_path_and_hash()`
- [x] `delete_sections_by_path_except_hash()`

#### 2.2 TypeScript APIラッパー（30分）
- [x] TypeScript側のAPI追加

#### 2.3 テスト（30分）
- [x] ハッシュによるフィルタのテスト
- [x] 選択的削除のテスト

### Phase 3: IndexWorkerの実装（4時間） ✅

**目標**: バックグラウンドでIndexRequestを処理

#### 3.1 IndexWorkerクラス（2時間）
- [x] `packages/server/src/worker/index-worker.ts`作成
- [x] `start()`, `stop()`, `processNextRequests()`
- [x] `getNextRequests()` - 最新リクエストのみ抽出
- [x] `processRequest()` - リクエスト処理ロジック

#### 3.2 Serverへの組み込み（1時間）
- [x] `packages/server/src/server/search-docs-server.ts`
- [x] サーバ起動時にWorkerを開始
- [x] サーバ停止時にWorkerを停止

#### 3.3 テスト（1時間）
- [x] Worker起動・停止のテスト
- [x] リクエスト処理のテスト
- [x] 複数リクエストの処理順序テスト

### Phase 4: ファイル更新時のIndexRequest作成（2時間） ✅

**目標**: ファイル変更時にIndexRequestを作成

#### 4.1 indexDocument()の更新（1時間）
- [x] `packages/server/src/server/search-docs-server.ts`
- [x] storage更新 + IndexRequest作成
- [x] 既存の同期的なindex作成を削除

#### 4.2 rebuildIndex()の更新（30分）
- [x] 複数ファイルに対してIndexRequestを一括作成
- [x] forceオプションの対応

#### 4.3 テスト（30分）
- [x] ファイル更新時のIndexRequest作成テスト
- [x] rebuild時の一括作成テスト

### Phase 5: 検索ロジックの更新（3時間） ✅

**目標**: indexStatusによるフィルタと状態表示

#### 5.1 検索オプションの拡張（1時間）
- [x] `SearchOptions`に`indexStatus`を追加
- [x] `indexStatus`によるpath除外ロジック

#### 5.2 Index状態の計算（1時間）
- [x] `computeIndexStatus()`の実装
- [x] 検索結果への状態情報付与

#### 5.3 テスト（1時間）
- [x] indexStatusフィルタのテスト
- [x] 状態計算のテスト（latest, updating, outdated）

### Phase 6: CLI出力の更新（1時間） ✅

**目標**: 検索結果にindex状態を表示

#### 6.1 出力フォーマット更新（30分）
- [x] `packages/cli/src/utils/output.ts`
- [x] text形式で`[最新]`, `[更新中]`を表示
- [x] JSON形式で`indexStatus`を出力

#### 6.2 テスト（30分）
- [x] 出力フォーマットのテスト

### Phase 7: 統合テスト（2時間） ✅

**目標**: 全体動作の確認

#### 7.1 E2Eテスト（1.5時間）
- [x] ファイル更新 → IndexRequest作成 → Worker処理 → 検索
- [x] 複数回更新時の動作確認
- [x] indexStatusフィルタの動作確認

#### 7.2 パフォーマンステスト（30分）
- [x] 大量ファイル更新時の動作
- [x] Worker処理速度の確認

**総推定工数**: 17時間

## 完了報告（2025-10-30）

### 実装完了項目

**Phase 1-7 全て完了** ✅

1. **データ構造修正**（Phase 5開始前）
   - Document型からtitleフィールドを削除、metadata.titleへ移動（オプショナル）
   - fileHashを必須フィールドに変更（`fileHash?: string` → `fileHash: string`）
   - 全実装コードとテストを修正

2. **Phase 5: 検索ロジックの更新**
   - SearchOptionsに`indexStatus`パラメータ追加
   - SearchResultに`indexStatus`, `isLatest`, `hasPendingUpdate`追加
   - `computeIndexStatus()`実装
   - Pythonのsearch()に`excludePaths`対応

3. **Phase 6: CLI出力の更新**
   - text形式で状態ラベル表示: `[最新]`, `[更新中]`, `[古い]`
   - JSON形式で全状態フィールド出力

4. **Phase 7: 統合テスト**
   - server: 89テスト全てパス ✅
   - storage: 29テスト全てパス ✅
   - db-engine: 23テスト全てパス ✅
   - **合計**: 141テスト全てパス ✅

### 変更ファイル

- `packages/types/src/api.ts` - SearchOptions/SearchResult拡張
- `packages/types/src/document.ts` - Document型修正
- `packages/server/src/server/search-docs-server.ts` - 検索ロジック実装
- `packages/db-engine/src/python/worker.py` - excludePaths対応
- `packages/server/src/__tests__/search-status.test.ts` - Phase 5テスト
- `packages/cli/src/utils/output.ts` - 出力フォーマット更新
- その他テストファイル修正多数

### 次のステップ

Task 8 Phase 1-7完了。FileWatcher統合が次の候補。

## マイルストーン

### Milestone 1: データレイヤー完成（Phase 1-2）
- IndexRequestとSection関連のDB操作が完成
- 推定: 5時間

### Milestone 2: Worker実装完成（Phase 3-4）
- バックグラウンド処理が動作
- 推定: 6時間

### Milestone 3: 検索機能完成（Phase 5-6）
- index状態のフィルタと表示が動作
- 推定: 4時間

### Milestone 4: 統合完成（Phase 7）
- 全体が統合され、テスト通過
- 推定: 2時間

## リスクと対策

### リスク1: LanceDBでのIndexRequestテーブル管理

**問題**: LanceDBはVector検索用で、リレーショナル操作が不得意

**対策**:
- IndexRequestは単純なCRUD操作のみ（Vector検索不要）
- 必要に応じてSQLiteなど別DBの検討
- まずはLanceDBで実装し、パフォーマンス問題があれば移行

### リスク2: Worker処理の遅延

**問題**: 大量の更新が発生した場合、Workerが追いつかない

**対策**:
- Worker処理の並列化（複数ファイルを同時処理）
- 優先度付け（よくアクセスされるファイルを優先）
- 処理状況の可視化（`index status`コマンド）

### リスク3: ディスク使用量の増加

**問題**: 古いindexが残る期間、ディスク使用量が増加

**対策**:
- Worker処理間隔を短く（5秒）
- 定期的なクリーンアップ（completedリクエストの削除）

## 成功基準

- [ ] ファイル更新時にIndexRequestが作成される
- [ ] Workerが自動的に最新リクエストのみ処理する
- [ ] 検索不能期間が発生しない
- [ ] 検索結果に正しいindex状態が表示される
- [ ] `indexStatus`フィルタが動作する
- [ ] 短時間の連続更新に対応できる
- [ ] 全テスト通過

## 次のステップ

Phase 1から順次実装を開始。

---

## 実装履歴

### 2025-10-30 午前セッション

**完了内容**:
1. pyproject.tomlパス解決の修正
   - `findProjectRoot()`から`import.meta.url`ベースの相対パス計算に変更
   - コミット: `0934fe0`, `7baed8f`

2. handleFileChangeのストレージ保存追加
   - ファイル変更時のストレージ保存処理が抜けていた問題を修正
   - コミット: `dfde13f`

**学んだこと**:
- 過度な一般化を避け、シンプルな解決策を選ぶ
- 実装より先に仕様書・設計ドキュメントを確認する

### 2025-10-30 午後セッション

**完了内容**:
1. __dirname ESM互換性問題の修正
   - db-engineパッケージのクリーンビルドで解決

2. サーバ起動と検索機能の有効化
   - watcher.enabled, worker.enabled を true に設定
   - 30ドキュメント、817セクションのインデックス化成功

3. rebuildIndex機能の改善
   - デフォルトでハッシュチェック有効（`force: false`）
   - `--force` オプション追加（強制再インデックス）
   - サーバ起動時に自動的にインデックス同期

**変更ファイル**:
- `packages/types/src/api.ts`: RebuildIndexRequestに`force`追加
- `packages/server/src/server/search-docs-server.ts`: rebuildIndex修正、起動時同期追加
- `packages/cli/src/commands/index/rebuild.ts`: forceパラメータ追加、モード表示

**動作確認**:
```bash
# スマートリビルド（変更検知）
$ node packages/cli/dist/index.js index rebuild
Mode: Smart rebuild (skip unchanged files)

# 強制リビルド
$ node packages/cli/dist/index.js index rebuild --force
Mode: Force rebuild (ignore hash check)

# 検索機能
$ node packages/cli/dist/index.js search "LanceDB" --limit 3
検索結果: 3件（115ms）
1. [score: 712.85] ... [最新]
```

**設計判断**:
- `indexDocument`はリクエスト作成のみで軽量
- 実際の重い処理（セクション分割、Vector化）はIndexWorkerが担当
- 起動時の自動同期は負荷が軽いため、毎回実行しても問題なし

---

## 次のステップ

Task 8は完了しました。次の作業候補：

### Task 9: MCP Server実装（推奨）
- Claude Codeから直接search-docsを利用可能に
- @docs/client-server-architecture.md に設計記載済み
- 推定工数: 4-6時間

### その他の候補
- Task 4残り: `index status`, `config`コマンド（低優先度）
- Task 7: dbPath修正の検証（30分）
- ドキュメント整備

---

**作成日**: 2025-10-30
**バージョン**: v2（IndexRequestテーブル導入版）
**状態**: 完了 ✅（Phase 1-7 + サーバ起動時同期機能）
**関連タスク**: Task 6（設計と実装の乖離調査）
**実装工数**: 約12時間（推定17時間のうち）
**完了日**: 2025-10-30
