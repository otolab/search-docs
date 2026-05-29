# @search-docs/mcp-server

## 1.9.4

### Patch Changes

- Updated dependencies [a1fb9b9]
  - @search-docs/db-engine@1.5.7
  - @search-docs/cli@1.2.3
  - @search-docs/server@1.5.3

## 1.9.3

### Patch Changes

- 967a4f1: MCP サーバに setupLogRedirect を適用し、console 出力をログファイルに転送
- Updated dependencies [967a4f1]
  - @search-docs/server@1.5.2
  - @search-docs/cli@1.2.2

## 1.9.2

### Patch Changes

- 23ef9ae: feat: MCP リソース追加と description/メッセージ整理 (#108)

  - MCP サーバーに instructions を追加（サーバー接続時にシステムプロンプトに表示）
  - MCP リソース 4 種を実装: getting-started, architecture, usage, config-reference
  - NOT_CONFIGURED 時のメッセージを改善し、関連プロジェクトが利用可能であることを明示
  - 全ツールの description をコンパクトに簡素化、詳細は MCP リソースへ誘導

## 1.9.1

### Patch Changes

- 0c8e22f: fix: SQL フィルタのシングルクォートおよび LIKE メタ文字エスケープ (#96)

  - worker.py に `_escape_sql()` / `_escape_like()` を追加し、全 SQL 文字列リテラルを安全にエスケープ
  - シングルクォートを含むファイルパスでの検索・更新・削除が正しく動作するように修正

  refactor: ConfigLoader を @search-docs/config パッケージに分離 (#91)

  - `@search-docs/types` から ConfigLoader / validateConfig / checkConfigDeprecations を新パッケージ `@search-docs/config` へ移動
  - server, cli, mcp-server の import パスを更新

- Updated dependencies [0c8e22f]
  - @search-docs/db-engine@1.5.6
  - @search-docs/config@1.0.1
  - @search-docs/types@1.5.1
  - @search-docs/server@1.5.1
  - @search-docs/cli@1.2.1
  - @search-docs/client@1.0.25
  - @search-docs/storage@1.0.23

## 1.9.0

### Minor Changes

- b46906e: feat: files.include → files.sources リネーム + shallow/deep ツリーウォーク監視

  - `files.include` を `files.sources` にリネーム（`include` は非推奨、後方互換あり）
  - パターンの `**` 有無で shallow/deep 監視を自動判定
  - ツリーウォーク方式でディレクトリを枝刈りしながら監視ターゲットを構築
  - shallow subscription に暗黙的 ignore を追加し、不要な inotify 走査を排除
  - COMMON_IGNORES 拡充（`.pnpm-store`, `.yarn`, `.uv`, `__pycache__`等）
  - CI: release-prepare で changeset 消費済みの場合にコミットをスキップ

### Patch Changes

- Updated dependencies [c97661d]
- Updated dependencies [b46906e]
  - @search-docs/db-engine@1.5.5
  - @search-docs/server@1.5.0
  - @search-docs/types@1.5.0
  - @search-docs/cli@1.2.0
  - @search-docs/client@1.0.24
  - @search-docs/storage@1.0.22

## 1.8.4

### Patch Changes

- 33563c9: fix: ConfigLoader.resolve()で config.project.root を絶対パスに解決するよう修正。Docker 環境で WatcherProcess が正しいディレクトリをスキャンしない問題を修正。
- Updated dependencies [33563c9]
  - @search-docs/types@1.4.3
  - @search-docs/server@1.4.4
  - @search-docs/cli@1.1.4
  - @search-docs/client@1.0.23
  - @search-docs/db-engine@1.5.4
  - @search-docs/storage@1.0.21

## 1.8.3

### Patch Changes

- dccec8b: MCP サービスを in-process 化し、関連プロジェクトを URL 接続に限定

  - SearchDocsService インターフェイスを追加し、in-process と HTTP アクセスを透過的に扱えるように
  - MCP サーバが SearchDocsServer インスタンスを直接保持する構成に変更（HTTP デーモン spawn 廃止）
  - RelatedProjectConfig から dir 指定を削除し、url 必須に変更
  - db-engine の get_stats で内部 API(\_dataset)を公開 API(to_lance())に修正
  - lancedb 0.25.3 → 0.30.2 へアップデート（Lance v3.0 対応）
  - Python 依存を全てバージョン固定（サプライチェーン対策）
  - torch/sentence-transformers 依存を削除（ONNX 移行済み）

- 7e71e7e: テスト整理・CI 構成追加・lint 修正
- Updated dependencies [dccec8b]
- Updated dependencies [7e71e7e]
  - @search-docs/types@1.4.2
  - @search-docs/server@1.4.3
  - @search-docs/client@1.0.22
  - @search-docs/db-engine@1.5.3
  - @search-docs/cli@1.1.3
  - @search-docs/storage@1.0.20

## 1.8.2

### Patch Changes

- 646485c: add_related_project に URL 接続オプションを追加。Docker 環境での localhost 自動補正対応。
- Updated dependencies [646485c]
  - @search-docs/types@1.4.1
  - @search-docs/cli@1.1.2
  - @search-docs/client@1.0.21

## 1.8.1

### Patch Changes

- @search-docs/cli@1.1.1

## 1.8.0

### Minor Changes

- bb08dfd: ### Docker MCP サーバ

  Docker 化された MCP サーバとして配布・利用可能に。1 イメージ・2 モード構成（MCP サーバ / Embedding サーバ）。

  - Dockerfile: マルチステージビルド（python-deps → node-build → runtime）
  - entrypoint.sh: モード分岐、Embedding サーバ自動検出
  - compose.yaml: 共有 Embedding サーバ構成例

  ### Embedding ONNX 化 + Ollama API 互換サーバ

  torch/sentence-transformers 依存を完全除去し、ONNX Runtime ベースに移行。Docker イメージサイズを 11GB → 2.5GB に削減。

  - embedding_server.py: Ollama API 互換 HTTP サーバ（/api/tags, /api/embed）
  - embedding_onnx.py: ONNX Runtime 推論エンジン
  - RemoteEmbeddingModel: ローカルモデルロード廃止、HTTP API 経由に一本化
  - embeddingUrl 設定: Embedding Server の URL を設定可能に

  ### WatcherProcess + Heartbeat 調停

  複数サーバインスタンス間でファイル監視を自動協調する仕組み。

  - watcher-process.ts: FileWatcher/IndexWorker/StartupSyncWorker を統合管理
  - writer_heartbeat テーブル（LanceDB）による排他制御
  - 状態マシン: sleeping → claiming → watching
  - サーバ統合: READ_ONLY/ENABLE_WATCHER 廃止、全サーバに WatcherProcess 内蔵

  ### 設定ファイル移行

  `.search-docs/config.json` を新しい設定ファイルパスとしてサポート。

  - ConfigLoader: `.search-docs/config.json` パスの探索・解決に対応
  - プロジェクトルート判定: `.search-docs/` サブディレクトリを考慮

  ### 型定義の拡張

  - GetStatusResponse: watcher 状態（sleeping/claiming/watching）を公開
  - IndexingConfig: embeddingUrl プロパティ追加
  - ServerConfig: readOnly プロパティ追加
  - デフォルト値: embeddingModel を ruri-v3-30m-onnx に変更、embeddingUrl 追加

  ### CLI embedding コマンド

  Embedding サーバの起動・停止・ステータス確認を CLI から直接管理可能に。

  - embedding start: デーモン起動、CoreML/CUDA 自動検出、モデルパス自動解決（Docker/キャッシュ/HuggingFace Hub）
  - embedding stop: PID ファイルベースの停止
  - embedding status: ヘルスチェック + プロセス情報表示
  - PID/ログは `~/.search-docs/` に配置（プロジェクト横断で共有）

  ### EmbeddingServerProcess TS 統合

  Embedding サーバのライフサイクル管理を TS 側（bin/server.ts）に移管。

  - EmbeddingServerProcess: 外部検出 → ローカル起動の自動判定
  - Docker entrypoint.sh 簡素化（Embedding 管理ロジック削除）
  - MCP ツール整理: init/system_status/list_related_projects/add_related_project 追加、server_start/server_stop 削除

  ### サーバ内部構造の刷新

  - DirtyWorker 廃止 → WatcherProcess 内の IndexWorker に統合
  - bin/server.ts: EmbeddingServerProcess → DBEngine → SearchDocsServer → WatcherProcess → JsonRpcServer の起動順序に整理
  - setupLogRedirect 共通化

  ### バグ修正

  - entrypoint.sh: bare except → `except Exception:`（SystemExit の誤キャッチ防止）
  - Dockerfile: libssl3 追加、UV_CACHE_DIR 権限修正
  - server.ts: Docker 環境での IPv4/IPv6 バインドミスマッチ修正（0.0.0.0 バインド）
  - @parcel/watcher: 2.5.1 → 2.5.6（Docker bind mount の inotify 非伝播修正）
  - file-watcher.ts: extglob パターン削除（C++ regex 遅延によるイベント消失修正）
  - heartbeat: 新規 DB 接続で readback（read_consistency_interval 問題の回避）

### Patch Changes

- Updated dependencies [bb08dfd]
  - @search-docs/types@1.4.0
  - @search-docs/cli@1.1.0
  - @search-docs/client@1.0.20

## 1.7.1

### Patch Changes

- 3361c2e: 全依存パッケージのバージョンを固定（Node.js/Python）
- Updated dependencies [3361c2e]
- Updated dependencies [49e53ea]
  - @search-docs/cli@1.0.39
  - @search-docs/client@1.0.19
  - @search-docs/types@1.3.4

## 1.7.0

### Minor Changes

- c69292e: NOT_CONFIGURED 状態でも関連プロジェクト経由で検索可能に

  - メインプロジェクト未設定でも add_related_project で関連プロジェクトを追加・検索可能
  - getAllRelatedProjects で config 由来の dir も絶対パスに解決し、パス解決を一本化
  - 全ツールを常時有効化し、各ツール内で状態に応じたエラーメッセージを表示
  - index_status に project 指定パラメータを追加

## 1.6.0

### Minor Changes

- f836ac2: add_related_project MCP ツールを追加

  - 関連プロジェクトを一時的にメモリ上で追加するツールを実装
  - 指定ディレクトリの .search-docs.json 存在チェックと名前重複チェックを実施
  - 既存ツール（list_related_projects, server_start, system_status）で一時追加分も参照するよう統合
  - RelatedProjectConfig 型をエクスポートに追加

### Patch Changes

- Updated dependencies [f836ac2]
  - @search-docs/types@1.3.3
  - @search-docs/cli@1.0.38
  - @search-docs/client@1.0.18

## 1.5.6

### Patch Changes

- a7f4920: MCP ツールの description とパラメータ説明を改善

  - ツール description にユースケースと返り値の情報を追加
  - オプションパラメータの説明を description から除外しパラメータ側に集約
  - project パラメータの冗長な説明を簡潔に統一
  - includeCleanOnly パラメータを syncedOnly にリネーム

## 1.5.5

### Patch Changes

- 3c063c5: 関連プロジェクトのサーバを server_start/server_stop で明示的に制御可能に

  - server_start/server_stop に project パラメータを追加
  - search/get_document/get_outline での関連プロジェクトサーバの自動起動を削除
  - ServerManager に getServer/stopRelatedServer メソッドを追加

## 1.5.4

### Patch Changes

- 78dfe04: 関連プロジェクト一覧を表示する list_related_projects ツールを追加

  - 設定ファイルで定義された関連プロジェクトの名前、説明、ディレクトリ、サーバ起動状態を一覧表示
  - search、get_document、get_outline の project パラメータ説明に list_related_projects への導線を追加

## 1.5.3

### Patch Changes

- @search-docs/cli@1.0.37

## 1.5.2

### Patch Changes

- @search-docs/cli@1.0.36

## 1.5.1

### Patch Changes

- 2ce035d: ドキュメント改善: README.md の作成と更新

  - packages/cli: README.md を新規作成。インストール方法、基本的な使い方、全コマンドの説明を追加
  - packages/mcp-server: README.md を全面的に改善
    - バージョン指定（v1.x.x 以降）を削除
    - get_outline ツールの説明を追加
    - 全ツールの出力例を削除し、パラメータと機能説明に集中
    - 実装に基づいて全パラメータを正確に記述

- Updated dependencies [2ce035d]
  - @search-docs/cli@1.0.35

## 1.5.0

### Minor Changes

- 59304d6: fix: セクション番号の表示問題を修正 (Issue #30)

  **破壊的変更**: データベース構造の変更により、インデックスの再構築が必要です。

  ## 問題

  get_outline でセクション番号が「1.1: Level 1」のように、H1 が 1.1 から始まっていました。

  ## 原因

  document root (depth=0) と H1 (depth=1) が同じ sectionNumber `[1]`を持っていたため、表示が重複していました。

  ## 修正内容

  - **データ層**: document root の sectionNumber を`[]`（空配列）に変更
  - **表示層**: 空の sectionNumber を"root"として表示
  - **テスト**: 包括的な sectionNumber 検証テストを追加

  ## 影響

  - **データベース**: sectionNumber の形式が変更されたため、インデックスの再構築が必要
  - **表示**: セクション番号が正しく表示されるようになります
    - 以前: "1.1: Level 1"
    - 修正後: "1: Level 1"

### Patch Changes

- @search-docs/cli@1.0.34

## 1.4.5

### Patch Changes

- Updated dependencies [6ecd3e6]
  - @search-docs/types@1.3.2
  - @search-docs/cli@1.0.33
  - @search-docs/client@1.0.17

## 1.4.4

### Patch Changes

- fe67c66: 文書構造を表示する get_outline ツールを追加し、ESLint エラーを修正しました。

  - 新機能: get_outline ツールで文書のアウトライン（セクション番号・行数・トークン数）を取得
  - path/sectionId 両対応、関連プロジェクトサポート
  - ESLint エラー修正: Python 型インターフェースの追加、未使用変数の修正

- Updated dependencies [fe67c66]
  - @search-docs/types@1.3.1
  - @search-docs/client@1.0.16
  - @search-docs/cli@1.0.32

## 1.4.3

### Patch Changes

- @search-docs/cli@1.0.31

## 1.4.2

### Patch Changes

- Updated dependencies [b8a2b70]
  - @search-docs/cli@1.0.30

## 1.4.1

### Patch Changes

- Updated dependencies [5ca2ecf]
  - @search-docs/cli@1.0.29

## 1.4.0

### Minor Changes

- 7d87e38: 関連プロジェクト検索機能を追加

  複数の search-docs プロジェクト間でドキュメントを横断検索できる機能を実装しました。

  **主な変更**:

  - 設定ファイルに`relatedProjects`セクションを追加
  - `search()`と`get_document()`に`project`パラメータを追加
  - `ServerManager`クラスで複数プロジェクトのサーバを管理
  - 関連プロジェクト情報を`get_system_status`で表示
  - サーバプロセスの作業ディレクトリ設定を修正

  **使用例**:

  ```typescript
  // 関連プロジェクトを検索
  await search({ query: "認証", project: "auth-service" });

  // 関連プロジェクトのドキュメント取得
  await getDocument({ path: "README.md", project: "auth-service" });
  ```

### Patch Changes

- Updated dependencies [7d87e38]
  - @search-docs/types@1.3.0
  - @search-docs/cli@1.0.28
  - @search-docs/client@1.0.15

## 1.3.0

### Minor Changes

- 検索結果の出力フォーマットを大幅に改善

  **主な変更**:

  - スコアを削除し、検索順位（n 位/m 件）を表示
  - セクションタイトルを「」で囲んで明示的に
  - 章節項号形式を実装（第 1 章 2 節 3 項 1 号）
  - セクション ID を行番号と同じ行に配置
  - コンテンツをインデントで視覚的に区別
  - 検索ヒントを追加（get_document、limit、previewLines の使い方）
  - ツールの description を改善

  **改善効果**:

  - 検索結果の構造が一目でわかるように
  - 続きの見方が明確に（get_document の使い方をガイド）
  - ファイルパスとタイトルの区別が明確に
  - 章節項号で文書内の位置が直感的に理解可能

## 1.2.3

### Patch Changes

- server_start/stop の不適切な reconnect 案内を削除

  変更内容:

  - server_start と server_stop のメッセージから reconnect 案内を削除
  - 2 状態モデルでは、これらの操作後にツールリストは変わらないため不要

  理由:

  - init 実行後のみ reconnect が必要（NOT_CONFIGURED → CONFIGURED）
  - server_start/stop 実行後は reconnect 不要（CONFIGURED 状態のまま）

## 1.2.2

### Patch Changes

- ツール有効化ロジックを 2 状態モデルに簡素化

  変更内容:

  - 状態を 2 つに簡素化: NOT_CONFIGURED（未設定）と CONFIGURED（設定済み）
  - CONFIGURED 状態では全ツールを常に利用可能に（サーバ起動状態に関わらず）
  - 各ツール内で状態チェックを行い、適切なエラーメッセージを返す

  理由:

  - Claude Code が MCP 通知に未対応のため、動的なツール切り替えが機能しない
  - reconnect が必要な現状では、最初から全ツールを有効にする方が実用的

## 1.2.1

### Patch Changes

- Claude Code 再接続が必要な旨の案内メッセージを追加

  変更内容:

  - init、server_start、server_stop 実行後に Claude Code 再接続を案内
  - Claude Code が MCP 通知に未対応のため、ツールリスト更新には再接続が必要
  - 動的ツール更新テストのポート競合を修正

## 1.2.0

### Minor Changes

- MCP 動的ツール登録の実装

  init 実行後に server_start などのツールが利用可能にならない問題を解決。システム状態に応じてツールの有効/無効を自動的に切り替えるよう実装。

  - MCP SDK の動的ツール管理機能を活用（.enable()/.disable()）
  - init 実行後、自動的にツールリストが更新される
  - システム状態とツールの対応を明確化
  - README.md に動的ツール登録の詳細説明を追加

## 1.1.5

### Patch Changes

- GPU メモリ最適化とバッチサイズ制御の改善

  - maxTokensPerText 削除、maxBatchTokens に統一して GPU メモリピークを確実に制御
  - バッチサイズを超えるセクションはベクトル化をスキップ
  - PyTorch MPS キャッシュクリア機能を追加
  - バッチ処理ごとにメモリを積極的に解放

- Updated dependencies
  - @search-docs/types@1.2.0
  - @search-docs/cli@1.0.27
  - @search-docs/client@1.0.14

## 1.1.4

### Patch Changes

- @search-docs/cli@1.0.26

## 1.1.3

### Patch Changes

- @search-docs/cli@1.0.25

## 1.1.2

### Patch Changes

- @search-docs/cli@1.0.24

## 1.1.1

### Patch Changes

- @search-docs/cli@1.0.23

## 1.1.0

### Minor Changes

- 691fccb: インデックス戦略の実装と前方一致検索の追加

  ## LanceDB インデックス戦略 (Phase 1)

  以下のインデックスを新規作成し、クエリパフォーマンスを最適化しました:

  **index_requests テーブル**:

  - `document_path` (BTREE): 等価検索の高速化
  - `document_hash` (BTREE): 等価検索の高速化

  **sections テーブル**:

  - `document_path` (BTREE): 等価検索の高速化、LIKE prefix 検索にも効果が期待される
  - `is_dirty` (BITMAP): Low-cardinality (2 値) カラムの高速化

  ## 前方一致検索機能

  search API に以下のオプションを追加しました:

  - `includePaths`: 指定パスプレフィックス配下のみを検索 (OR 条件)
  - `excludePaths`: 指定パスプレフィックス配下を除外 (AND 条件)

  例:

  ```typescript
  // docs/配下のみを検索
  search({ query: "検索語", options: { includePaths: ["docs/"] } });

  // docs/internal/とtemp/を除外
  search({
    query: "検索語",
    options: { excludePaths: ["docs/internal/", "temp/"] },
  });

  // 組み合わせ: prompts/配下でprompts/tasks/を除外
  search({
    query: "検索語",
    options: {
      includePaths: ["prompts/"],
      excludePaths: ["prompts/tasks/"],
    },
  });
  ```

  ## 技術詳細

  - LanceDB LIKE 演算子による前方一致検索
  - DataFusion 46.0.0 の NOT LIKE 最適化を活用
  - BTREE インデックスの効果は今後のパフォーマンステストで検証予定

### Patch Changes

- Updated dependencies [691fccb]
  - @search-docs/types@1.1.0
  - @search-docs/cli@1.0.22
  - @search-docs/client@1.0.13

## 1.0.26

### Patch Changes

- @search-docs/cli@1.0.21

## 1.0.25

### Patch Changes

- @search-docs/cli@1.0.20

## 1.0.24

### Patch Changes

- @search-docs/cli@1.0.19

## 1.0.23

### Patch Changes

- **PID ファイル競合状態の修正とビルドプロセス改善**

  **修正内容**:

  1. **server: PID ファイル競合状態の修正**

     - デーモン起動時に自分自身の PID を除外するロジックを追加
     - `existingPid.pid !== process.pid` チェックを追加
     - サーバプロセスが自分自身を「既に起動中」と誤認する問題を解決

  2. **すべてのパッケージ: prepublishOnly スクリプト追加**
     - npm publish 時に自動的にビルドを実行
     - 古いビルド成果物が誤って公開される問題を防止
     - 一貫性のあるリリースプロセスを確保

  **修正された問題**:

  - デーモンモードでのサーバ起動タイムアウト
  - npm publish 時の古いコードの公開

  **Breaking Changes**: なし

- Updated dependencies
  - @search-docs/cli@1.0.18
  - @search-docs/client@1.0.12
  - @search-docs/types@1.0.12

## 1.0.22

### Patch Changes

- Updated dependencies
  - @search-docs/cli@1.0.17
  - @search-docs/types@1.0.11
  - @search-docs/client@1.0.11

## 1.0.21

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.10
  - @search-docs/cli@1.0.16
  - @search-docs/client@1.0.10

## 1.0.20

### Patch Changes

- Updated dependencies [1402dc7]
  - @search-docs/types@1.0.9
  - @search-docs/cli@1.0.15
  - @search-docs/client@1.0.9

## 1.0.19

### Patch Changes

- 5d5cbda: fix(db-engine): テーブルハンドルをキャッシュしてメモリリークを修正

  open_table()を繰り返し呼ぶと各インスタンスが独自の index/metadata キャッシュを持ち、メモリを消費する問題を修正。LanceDB のベストプラクティスに従い、テーブルハンドルを一度だけ開いて再利用するよう変更。

- Updated dependencies [5d5cbda]
  - @search-docs/cli@1.0.14

## 1.0.18

### Patch Changes

- @search-docs/cli@1.0.13

## 1.0.17

### Patch Changes

- @search-docs/cli@1.0.12

## 1.0.16

### Patch Changes

- @search-docs/cli@1.0.11

## 1.0.15

### Patch Changes

- @search-docs/cli@1.0.10

## 1.0.14

### Patch Changes

- 設定ファイルが見つからない場合のエラーメッセージを改善しました。

  変更内容:

  - 設定ファイル不在時のエラーメッセージをより詳しく、分かりやすく改善
  - CLI コマンドでの初期化方法（npx @search-docs/cli config init）を案内
  - 手動作成する場合の最小限の設定例を表示
  - MCP Server 経由で使用している場合でも対応方法が明確に

## 1.0.13

### Patch Changes

- depth パラメータを maxDepth（最大深度）として正しく実装しました。

  変更内容:

  - Python 検索条件を `depth = X` から `depth <= X` に変更
  - depth の意味を「この深度まで検索」に明確化
    - 0=文書全体のみ
    - 1=文書全体+章まで（H1 まで）
    - 2=文書全体+章+節まで（H1, H2 まで）
    - 3=すべて（H1, H2, H3 まで）
  - 「枝葉まで検索しない」という用途に対応

- Updated dependencies
  - @search-docs/types@1.0.8
  - @search-docs/cli@1.0.9
  - @search-docs/client@1.0.8

## 1.0.12

### Patch Changes

- depth 配列指定機能を削除し、単一の数値のみを受け付けるように変更しました。

  変更内容:

  - SearchOptions.depth の型を `number | number[]` から `number` に変更
  - Python 側の depth 配列処理を削除
  - CLI 引数を `--depth <depths...>` から `--depth <depth>` に変更
  - MCP ツールの description を改善し、depth（0-3）と includeCleanOnly の意味を明確化
    - depth: 0=文書全体、1=H1(章)、2=H2(節)、3=H3(項)
    - includeCleanOnly: 最新の文書内容のみを検索対象とする
  - 検索結果に含まれる行番号とセクション ID の用途を説明に追加

- Updated dependencies
  - @search-docs/types@1.0.7
  - @search-docs/cli@1.0.8
  - @search-docs/client@1.0.7

## 1.0.11

### Patch Changes

- @search-docs/cli@1.0.7

## 1.0.10

### Patch Changes

- get_document の path と sectionId をオプショナルに変更し、どちらか一方で取得可能にしました。

  変更内容:

  - path と sectionId をどちらもオプショナルに変更（ただし、どちらか一方は必須）
  - sectionId のみで特定のセクションを取得できるように
  - マルチバイト文字（日本語）のテストを追加し、正しく扱えることを確認

- Updated dependencies
  - @search-docs/types@1.0.6
  - @search-docs/cli@1.0.6
  - @search-docs/client@1.0.6

## 1.0.9

### Patch Changes

- get_document ツールに sectionId パラメータを追加しました。

  変更内容:

  - inputSchema に sectionId（オプショナル）パラメータを追加
  - 検索結果に表示されるセクション ID を使って、特定のセクションのみを取得できるように
  - セクション取得時の出力フォーマットを追加（Level, Section, Line などのメタデータを表示）

## 1.0.8

### Patch Changes

- 検索結果の出力フォーマットを 1 行形式に改善し、可読性を向上しました。

  変更内容:

  - メタデータ表示を複数行から 1 行形式に変更（Level, Section, Line, Score を`|`区切りで表示）
  - sectionNumber、startLine、endLine などの新しいフィールドに対応
  - indexStatus は'updating'または'outdated'の場合のみ表示
  - コンテンツを Markdown コードブロックで明確に表示

## 1.0.7

### Patch Changes

- 5781444: package.json からバージョンを動的に読み込むように修正

  ハードコードされていた'0.1.0'を package.json から読み込むように変更し、-V オプションで正しいバージョンが表示されるようにしました。

## 1.0.6

### Patch Changes

- 9b5820a: 検索結果に startLine/endLine/sectionNumber フィールドを追加

  検索結果に文書内の位置情報を追加し、検索結果からソースファイルの該当箇所を特定できるようにしました。

  **主な変更**:

  - Section 型に 3 つの新フィールドを追加（startLine, endLine, sectionNumber）
  - MarkdownSplitter で行番号とセクション番号を自動生成
  - Python-TypeScript 変換層で新フィールドを変換
  - CLI 出力に位置情報を表示
  - MCP Server で新フィールドを提供
  - Python 側でフィールドのバリデーションと型変換を追加（null 値を防止）

  **影響範囲**:

  - 既存のインデックスは再構築が必要です（`search-docs index rebuild`または`.search-docs/index`を削除してサーバ再起動）

- Updated dependencies [9b5820a]
  - @search-docs/types@1.0.5
  - @search-docs/cli@1.0.5
  - @search-docs/client@1.0.5

## 1.0.4

### Patch Changes

- MCP Server 起動時のログ出力を抑制

  通常モードでは標準エラー出力にログを出さないように変更。
  デバッグ時は`DEBUG=1`環境変数または`NODE_ENV=development`でログ出力。

## 1.0.3

### Patch Changes

- Bug fixes and improvements

  - **cli**: ESM 互換性修正、config init 改善、depth 表示改善、ログ記録機能追加
  - **server**: file-watcher テスト安定性向上
  - **mcp-server**: --project-dir オプションをオプショナル化

- Updated dependencies
  - @search-docs/cli@1.0.3

## 1.0.2

### Patch Changes

- 初期リリース後の不足機能追加と改善

  - config init コマンドの追加（設定ファイル生成）
  - グローバル--config オプションの実装
  - サーバ起動デフォルトをバックグラウンドに変更
  - 設定ファイル必須化（ポート衝突回避のため）
  - ConfigLoader.resolve()に requireConfig パラメータを追加

- Updated dependencies
  - @search-docs/cli@1.0.2
  - @search-docs/types@1.0.1
  - @search-docs/client@1.0.1

## 1.0.1

### Patch Changes

- ## Bug Fixes and Enhancements

  ### CLI: Port Configuration Support

  - Add `resolveServerUrl()` utility to read port configuration from `.search-docs.json`
  - Fix all CLI commands (search, index rebuild, index status) to use configured port instead of hardcoded default
  - Add `--config` option to all client commands for explicit config file path

  ### MCP Server: Auto-start Server

  - Add `ServerManager` class to automatically start search-docs server when not running
  - Use `import.meta.resolve()` to locate `@search-docs/cli` package
  - Add `@search-docs/cli` as dependency to enable auto-start functionality
  - Implement graceful cleanup on process termination (SIGINT/SIGTERM)

  ### Server: Fix EMFILE Error in File Watcher

  - Add directory-level filtering to exclude common directories with many files (node_modules, .git, .venv, dist, build, etc.)
  - Configure chokidar options for better file descriptor management
  - Enable native fsEvents on macOS with `usePolling: false`

  ## User Impact

  **Before**: Users needed to install both `@search-docs/cli` and `@search-docs/mcp-server`, and manually start the server

  **After**: Users only need to install `@search-docs/mcp-server`, which automatically starts the server when needed

  **Port Configuration**: Multiple projects can now run servers on different ports as configured in `.search-docs.json`

- Updated dependencies
  - @search-docs/cli@1.0.1

## 1.0.0

### Major Changes

- Initial release of search-docs - Local document vector search system

  ## Features

  - 🔍 Vector search for Markdown documents using LanceDB
  - 📝 Automatic document sectioning (depth 0-3)
  - 🚀 Client-server architecture with JSON-RPC
  - 🐕 CLI tool for easy document searching
  - 🤖 MCP Server for Claude Code integration
  - 🇯🇵 Optimized for Japanese with Ruri Embedding Models
  - 📦 Complete TypeScript + Python hybrid implementation

  ## Packages

  - **@search-docs/cli** - Command-line interface
  - **@search-docs/client** - TypeScript client library
  - **@search-docs/server** - Search server
  - **@search-docs/mcp-server** - MCP Server for Claude Code
  - **@search-docs/storage** - Document storage
  - **@search-docs/db-engine** - LanceDB vector search engine
  - **@search-docs/types** - TypeScript type definitions

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.0
  - @search-docs/client@1.0.0
