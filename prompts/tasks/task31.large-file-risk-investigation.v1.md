# Task 31: 超巨大ファイル読み込みリスク調査

**作業日**: 2026-03-27
**状態**: 完了

## 調査目的

search-docsプロジェクトで、超巨大なファイルを誤って読み込むリスクがあるか調査する。

## 調査観点

1. ファイル読み込みの入り口
2. 設定ファイルのinclude/excludeルール
3. ファイルディスカバリ
4. ファイル監視（FileWatcher）
5. ドキュメント登録・更新フロー

## 調査結果

### 1. ファイル読み込み箇所の特定

#### 1.1 FileStorage（`packages/storage/src/file-storage.ts`）
- **目的**: DocumentStorageの読み書き（内部ストレージ、Markdownファイル本体ではない）
- **読み込み箇所**: L62 `await fs.readFile(filePath, 'utf-8')`
- **対象**: `.search-docs/documents/` 配下のJSON形式の内部データ
- **サイズチェック**: **なし**
- **リスク**: 低（内部データであり、元のMarkdownファイルの内容をそのまま保存したもの）

#### 1.2 FileDiscovery（`packages/server/src/discovery/file-discovery.ts`）
- **目的**: Markdownファイルのパス検索
- **読み込み箇所**: L128 `.gitignore`読み込みのみ `await fs.readFile(gitignorePath, 'utf-8')`
- **サイズチェック**: **なし**（ただし.gitignoreファイルは通常小さい）
- **リスク**: 極めて低（.gitignore自体が巨大になることは稀）

#### 1.3 SearchDocsServer（`packages/server/src/server/search-docs-server.ts`）
**重要**: ここがMarkdownファイル本体を読み込む主要箇所

##### (A) ファイル変更イベント処理（L170）
```typescript
private async handleFileChange(event: FileChangeEvent): Promise<void> {
  // ...
  const absolutePath = path.join(this.config.project.root, event.path);
  const content = await fs.readFile(absolutePath, 'utf-8');  // ★ サイズチェックなし
  // ...
}
```
- **トリガー**: FileWatcherからのファイル変更イベント
- **サイズチェック**: **なし**
- **リスク**: **高**

##### (B) indexDocument API（L394）
```typescript
async indexDocument(request: IndexDocumentRequest): Promise<IndexDocumentResponse> {
  // ...
  const content = await fs.readFile(path, 'utf-8');  // ★ サイズチェックなし
  // ...
}
```
- **トリガー**: CLIやMCPからの手動インデックス要求、rebuildIndex内部からの呼び出し
- **サイズチェック**: **なし**
- **リスク**: **高**

#### 1.4 IndexWorker（`packages/server/src/worker/index-worker.ts`）
- **目的**: IndexRequestの処理（インデックス生成）
- **読み込み箇所**: L191 `await this.storage.get(request.documentPath)`
- **実態**: FileStorage経由で`.search-docs/documents/`から読み込む（既にメモリに保存済みのもの）
- **サイズチェック**: **なし**
- **リスク**: 中（既に1.3でメモリに読み込まれたデータを再利用）

### 2. ファイル選択フロー

#### 2.1 FileDiscovery（`packages/server/src/discovery/file-discovery.ts`）
**findFiles()メソッド（L41-62）**:
- fast-globでinclude/excludeパターンによるファイル検索
- `.gitignore`の尊重（オプション）
- **サイズフィルタリング**: **なし**
- 返すのはファイルパスのリストのみ

#### 2.2 FileWatcher（`packages/server/src/discovery/file-watcher.ts`）
**shouldProcessFile()メソッド（L129-151）**:
- `.md`拡張子チェック
- includeパターンマッチング
- **サイズチェック**: **なし**
- ファイルが条件に合致すれば、サイズに関係なく`change`イベントを発火

### 3. 設定ファイルによる制限

#### 3.1 設定可能な項目（`packages/types/src/config.ts`）
```typescript
export interface FilesConfig {
  include: string[];    // 含めるファイルパターン（glob）
  exclude: string[];    // 除外するファイルパターン（glob）
  ignoreGitignore: boolean;
}
```
- **ファイルサイズ制限の設定項目**: **なし**
- ユーザーが巨大ファイルを除外するには、手動でexcludeパターンに追加する必要がある

#### 3.2 デフォルト除外パターン（`packages/types/src/config.ts` L116）
```typescript
exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
```
- 一般的な大規模ディレクトリは除外されている
- しかし、個別の巨大ファイルを除外する仕組みはない

### 4. データ処理フロー

#### 4.1 rebuildIndex（`packages/server/src/server/search-docs-server.ts` L443-479）
```typescript
async rebuildIndex(request: RebuildIndexRequest = {}): Promise<RebuildIndexResponse> {
  // ...
  filesToIndex = await this.discovery.findFiles();  // ファイルパス取得
  for (const filePath of filesToIndex) {
    const result = await this.indexDocument({ path: filePath, force });  // ★ 1ファイルずつ読み込み
    // ...
  }
}
```
- 全ファイルを順次処理
- 各ファイルで`indexDocument` → `fs.readFile`を呼び出し
- **サイズチェック**: **なし**

#### 4.2 IndexWorker処理（`packages/server/src/worker/index-worker.ts`）
- ストレージから文書取得（L191）
- 既にメモリに読み込まれた内容を使用
- Markdown Splitterで分割（L233-237）
- **サイズ制限**: トークン数ベースの分割（デフォルト: maxTokensPerSection=2000）はあるが、**ファイル全体のサイズ制限はなし**

#### 4.3 DBEngine（Python側、`packages/db-engine/src/python/worker.py`）
- add_sections（L783-）: セクション単位で処理
- トークン数ベースのバッチ分割（L806）
- **ファイルサイズ制限**: **なし**（セクション単位のトークン数制限のみ）

### 5. 既知のサイズ関連機能

#### 5.1 rotating-log（`packages/server/src/utils/rotating-log.ts`）
- ログファイルのローテーション機能
- maxSize設定あり（デフォルト: 1MB）
- **対象**: ログファイルのみ（Markdownファイルには無関係）

#### 5.2 型定義とドキュメントの不一致
- **ドキュメント**（`docs/type-definitions.md` L69）: `size: number` フィールドの記述あり
- **実装**（`packages/types/src/document.ts`）: `size`フィールドは**存在しない**
- **乖離**: ドキュメントと実装が一致していない

### 6. リスク評価

#### 6.1 超巨大ファイル読み込みのリスク: **高**

**サイズチェックがない箇所**:
1. `SearchDocsServer.handleFileChange()` - L170
2. `SearchDocsServer.indexDocument()` - L394
3. `FileDiscovery.findFiles()` - パス検索時
4. `FileWatcher.shouldProcessFile()` - 監視対象判定時

**影響範囲**:
- ファイル監視で巨大な.mdファイルが追加/変更された場合
- `search-docs index rebuild`コマンド実行時
- `indexDocument` API直接呼び出し時

**想定される問題**:
1. **メモリ不足**: 数百MB〜数GBのファイルを`readFile`で全文読み込み
2. **プロセスクラッシュ**: Node.jsのヒープサイズ制限超過
3. **応答性低下**: 巨大ファイル処理中の他のリクエスト遅延
4. **DBエンジンの負荷**: 巨大なセクションデータのベクトル化

#### 6.2 現在の緩和策

**部分的な保護**:
1. トークン数ベースの分割（maxTokensPerSection=2000）により、セクション単位では制限あり
2. デフォルトのexcludeパターンで大規模ディレクトリを除外
3. Python側のバッチ処理でmaxBatchTokens（デフォルト: 4000）による制限

**不十分な点**:
- ファイル読み込み前のサイズチェックがない
- 100MBのMarkdownファイルでも、読み込みは試行される
- ユーザーが意図せず巨大ファイルをincludeに含めた場合、防御手段がない

### 7. 推奨される対策

#### 7.1 即時対応（優先度: 高）

**A. ファイルサイズ制限の導入**
- `FilesConfig`に`maxFileSizeBytes`オプション追加（デフォルト: 10MB程度）
- `SearchDocsServer`の`handleFileChange`と`indexDocument`で、`fs.stat()`によるサイズチェック
- サイズ超過時はエラーログ出力 + スキップ

**B. FileDiscoveryでのフィルタリング**
- `findFiles()`でファイルサイズを確認
- 巨大ファイルは警告ログ + 除外

**C. FileWatcherでの事前チェック**
- `shouldProcessFile()`でサイズチェック追加
- 巨大ファイルの変更イベントを無視

#### 7.2 中期対応（優先度: 中）

**A. ストリーム処理の導入**
- 巨大ファイルを一度に全文読み込まず、行単位/チャンク単位で処理
- Markdown Splitterをストリームベースに改良

**B. 設定ファイルの拡張**
```typescript
export interface FilesConfig {
  include: string[];
  exclude: string[];
  ignoreGitignore: boolean;
  maxFileSizeBytes?: number;  // 追加
  warnFileSizeBytes?: number; // 追加（警告のみ）
}
```

**C. ドキュメント修正**
- `docs/type-definitions.md`から存在しない`size`フィールドの記述を削除
- または、実装に`size`フィールドを追加

#### 7.3 長期対応（優先度: 低）

**A. プログレッシブ読み込み**
- 巨大ファイルを部分的にインデックス化
- ファイルの先頭N行のみを処理するオプション

**B. 外部ファイル対応**
- 巨大ファイルは外部ストレージ（S3等）に保存
- メタデータのみをインデックス化

## 結論

### 発見された問題

1. **ファイルサイズチェックが存在しない**: すべての読み込み箇所でサイズ制限なし
2. **設定項目の欠如**: `maxFileSizeBytes`のような設定がない
3. **ドキュメント不一致**: 型定義ドキュメントに存在しない`size`フィールドの記述

### リスクシナリオ

**シナリオ1**: ユーザーが100MBのログファイル（.md拡張子）をプロジェクトに配置
- FileWatcherがイベント検知
- `handleFileChange`で全文読み込み試行
- Node.jsプロセスがOOMクラッシュ

**シナリオ2**: 自動生成された巨大なMarkdownドキュメント（50MB）
- `search-docs index rebuild`実行
- `indexDocument`で読み込み
- メモリ使用量が急増し、システム全体が遅延

**シナリオ3**: 誤って大規模なログディレクトリをincludeに指定
- 数千の大きなファイルを順次読み込み
- プロセスが長時間応答不能

### 推奨アクション

**即座に実装すべき対策**:
1. ファイル読み込み前のサイズチェック（`fs.stat()`）
2. デフォルト10MBのサイズ制限
3. 設定ファイルでの`maxFileSizeBytes`オプション追加

**ドキュメント修正**:
- `docs/type-definitions.md`のsize記述を削除または実装追加

## 参考ファイル

- `/Users/naoto.kato/Develop/otolab/search-docs/packages/server/src/server/search-docs-server.ts` (L170, L394)
- `/Users/naoto.kato/Develop/otolab/search-docs/packages/server/src/discovery/file-discovery.ts`
- `/Users/naoto.kato/Develop/otolab/search-docs/packages/server/src/discovery/file-watcher.ts`
- `/Users/naoto.kato/Develop/otolab/search-docs/packages/storage/src/file-storage.ts`
- `/Users/naoto.kato/Develop/otolab/search-docs/packages/types/src/config.ts`
- `/Users/naoto.kato/Develop/otolab/search-docs/docs/type-definitions.md`
