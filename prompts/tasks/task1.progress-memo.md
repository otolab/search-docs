# 作業進捗メモ - search-docs実装

## 最終更新
2025-01-27

## Phase 1: 基盤パッケージ

### 1.1 packages/types ✅ 完了
- Document, Section, Config, API型を定義
- ビルド成功
- コミット完了

### 1.2 packages/storage ✅ 完了
- FileStorageクラス実装
- 15テストケース作成、全て通過
- ビルド成功
- コミット完了

### 1.3 packages/db-engine ✅ 完了

#### Python実装 ✅ 完了
- ✅ schemas.py: PyArrow schema定義
- ✅ embedding.py: Ruri埋め込みモデル統合
- ✅ worker.py: LanceDB JSON-RPCワーカー実装

**実装詳細**:
```
packages/db-engine/src/python/
├── schemas.py       # sections テーブルスキーマ
├── embedding.py     # RuriEmbedding (256d/768d対応)
└── worker.py        # SearchDocsWorker (JSON-RPC)
```

**参考元**: sebas-chan/packages/db/src/python/

#### TypeScript実装 ✅ 完了
- ✅ TypeScriptラッパー作成 (index.ts)
  - Pythonワーカープロセス起動
  - JSON-RPC通信
  - 型付きインターフェイス提供
- ✅ テスト作成 (db-engine.test.ts)
  - 接続テスト
  - CRUD操作テスト
  - 検索テスト (depth フィルタ含む)
  - Dirty管理テスト
  - 統計情報テスト

#### Python環境 ✅ 完了
- ✅ pyproject.toml設定
- ✅ uv sync実行 (47パッケージインストール)
- ✅ sentence-transformers, lancedb導入完了

**成果物**:
- `@search-docs/db-engine`
- 13テストケース作成
- ビルド成功

## ドキュメント作成 ✅ 完了

- ✅ implementation-details.md: 実装詳細、型定義、通信プロトコル
- ✅ type-definitions.md: 全型定義のリファレンス
- ✅ architecture-decisions.md: ADR（アーキテクチャ決定記録）

**内容**:
- 設計意図と実装判断の記録
- 型定義の詳細な説明と使用例
- 10個の主要なアーキテクチャ決定（ADR-001〜010）
  - ハイブリッド構成、JSON-RPC、トークン分割、Dirty管理など

## Phase 2: サーバ実装 🔄 進行中

### 2.1 設定管理 ✅ 完了

- ✅ ConfigLoaderクラス実装
  - JSONファイル読み込み
  - バリデーション
  - デフォルト値マージ
- ✅ validator実装（全設定項目対応）
- ✅ テスト作成（17テストケース）
- ✅ ビルド成功

**実装詳細**:
```
packages/server/src/config/
├── loader.ts           # ConfigLoader
├── validator.ts        # バリデーション関数
└── __tests__/
    └── config.test.ts  # 17テストケース
```

**対応設定**:
- project: name, root
- files: include, exclude, ignoreGitignore
- indexing: maxTokensPerSection, minTokensForSplit, maxDepth, vectorDimension, embeddingModel
- search: defaultLimit, maxLimit, includeCleanOnly
- server: host, port, protocol
- storage: documentsPath, indexPath, cachePath
- worker: enabled, interval, maxConcurrent

### 2.2 ファイル検索 ✅ 完了

- ✅ FileDiscoveryクラス実装
  - fast-globによるGlobパターンマッチング
  - .gitignore解析（ignoreパッケージ）
  - パス正規化
  - パターンマッチング判定
- ✅ テスト作成（9テストケース）
- ✅ ビルド成功

**実装詳細**:
```
packages/server/src/discovery/
├── file-discovery.ts
└── __tests__/
    └── file-discovery.test.ts  # 9テストケース
```

**機能**:
- findFiles(): Globパターンでファイル検索
- matchesPattern(): パターンマッチング判定
- shouldIgnore(): 除外判定（.gitignore対応）

**依存パッケージ**:
- fast-glob: 高速Glob検索
- ignore: .gitignore互換パーサー
- chokidar: ファイル監視（次のステップで使用）

### 2.3 Markdown分割 ✅ 完了

- ✅ TokenCounterクラス実装
  - gpt-tokenizerでトークン数計測
  - エラー時は文字数÷4でフォールバック
- ✅ MarkdownSplitterクラス実装
  - markedでMarkdownパース
  - H1-H3で階層構造抽出
  - H4以降は親セクションに含める
  - token.rawでMarkdown形式保持
  - サマリフィールドをundefinedで確保
  - **階層的コンテンツ実装（Phase 1完了）**
    - 親セクションに子のコンテンツをすべて含める
    - depth=0は常に文書全体を表す
    - 各depthレベルで完全な意味を持つ
- ✅ テスト作成
  - TokenCounter: 9テストケース
  - MarkdownSplitter: 25テストケース
  - 全テスト成功
- ✅ ビルド成功

**実装詳細**:
```
packages/server/src/splitter/
├── token-counter.ts              # TokenCounter
├── markdown-splitter.ts          # MarkdownSplitter
└── __tests__/
    ├── token-counter.test.ts     # 9テストケース
    └── markdown-splitter.test.ts # 25テストケース
```

**機能**:
- 章立てベースの機械的な分割
- トークン数計測と警告
- depth 0-3の階層構造
- maxDepth制限対応
- サマリフィールド確保（将来のLLM生成用）
- **階層的コンテンツ**: 親セクションは子のコンテンツをすべて含む
  - depth=0: 文書全体（すべてのH1, H2, H3を含む）
  - depth=1: H1 + その下のすべてのH2, H3
  - depth=2: H2 + その下のすべてのH3
  - depth=3: H3のみ
- マクロ・ミクロ両面での検索精度向上

### 2.4 サーバコア ✅ 完了

- ✅ SearchDocsServerクラス実装
  - search, getDocument, indexDocument, rebuildIndex, getStatus API
  - インデックス作成パイプライン（ファイル読み込み→分割→保存→DB追加）
  - FileStorage, DBEngine統合
- ✅ DirtyWorkerクラス実装
  - 定期実行でDirtyセクションを再インデックス
  - 文書ごとにグループ化して効率的に処理
- ✅ ビルド成功

**実装詳細**:
```
packages/server/src/
├── server/
│   ├── search-docs-server.ts  # メインサーバクラス
│   └── dirty-worker.ts         # Dirtyワーカー
└── index.ts                    # エクスポート
```

**機能**:
- 検索API: DBEngineに委譲
- 文書取得API: FileStorageから取得
- インデックスAPI: Markdown分割→保存→DB追加
- 再構築API: 全ファイル or 指定ファイルを再インデックス
- ステータスAPI: サーバ・インデックス・ワーカー情報
- Dirtyワーカー: バックグラウンドで自動再インデックス

### 次のステップ

⏳ 2.5 ファイル監視（Watch機能）

## 階層的コンテンツ実装（Phase 1）✅ 完了

**課題**: `docs/hierarchical-content-issue.md` で定義

**実装内容**:
1. ✅ `buildContent()` を修正: 子のコンテンツを再帰的に含める
2. ✅ `extractHeadingStructure()` を修正: depth=0を文書全体に
3. ✅ トークン数警告機能（既存）
4. ✅ テスト全面更新（25テストケース）

**効果**:
- 各depthレベルで完全な意味を持つベクトルインデックス
- マクロ（文書全体）とミクロ（セクション）の両面で検索可能
- 例: 「Node.jsのnpmインストール」で文書全体〜小節まで段階的にマッチ

**次のステップ（Phase 2）**:
- LLMでサマリ生成
- contentフィールドにサマリを統合
- 単一ベクトルで完全なコンテキスト保持

## バグ修正（2025-01-27）✅ 完了

**発見した問題**：
1. MarkdownSplitter: H3セクションのコンテンツが追加されないバグ
2. FileDiscovery: Glob→Regex変換の不具合（正規表現の`?`が誤変換）

**修正内容**：
1. ✅ `extractHeadingStructure()` に `currentDepth3` 変数を追加
   - H3ノードの後のコンテンツを正しく追跡
   - コンテンツ追加ロジックを `currentDepth3 || currentDepth2 || currentDepth1` に簡素化
2. ✅ `convertGlobToRegex()` の置換順序を修正
   - グロブパターンの`?`をプレースホルダーで保護
   - 正規表現の`?`（0回または1回）が誤って`.`に置換される問題を解決

**テスト結果**：
- MarkdownSplitter: 25/25 成功 ✅
- FileDiscovery: 10/10 成功 ✅
- TokenCounter: 9/9 成功 ✅
- Config: 18/18 成功 ✅
- **合計: 62/62 全テスト成功** 🎉

## 次のアクション

1. ✅ db-engineの実装完了
2. ✅ ドキュメント作成完了
3. ✅ Phase 2.1 - 設定管理完了
4. ✅ Phase 2.2 - ファイル検索完了
5. ✅ Phase 2.3 - Markdown分割完了
6. ✅ 階層的コンテンツ実装（Phase 1）完了
7. ✅ Phase 2.4 - サーバコア完了
8. ✅ バグ修正完了（H3コンテンツ、Glob変換）
9. ✅ コミット完了（f04918c）
10. ⏳ Phase 2.5 - ファイル監視実装に進む

## メモ

- Pythonワーカーは stdin/stdout で JSON-RPC通信
- sebas-chanの実装パターンを踏襲
- モデル初期化は遅延実行（initialize()メソッド）
- ベクトル次元は256 (ruri-v3-30m) または 768 (ruri-v3-310m)
