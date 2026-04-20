# task36: Embedding HTTP化 - ローカルモデルロード廃止

**作成日**: 2026-04-14
**状態**: 完了

## 背景

task34のDocker化の続き。db-engine内でローカルにRuri Embeddingモデルをロードするパスを廃止し、Embedding Server（HTTP API）経由のRemoteEmbeddingModelに一本化する。

## 変更内容

### Python側
- **embedding.py**: `detect_embedding_server()` 削除、`create_embedding_model()` を `(embedding_url, vector_dimension)` シグネチャに変更しRemoteEmbeddingModelのみ返す
- **worker.py**: `--model` → `--embedding-url` 引数に変更、`initModel()` で /health からモデル情報取得、`init_tables()` を initModel() 内に移動（vector_dimension確定後）

### TypeScript側
- **index.ts**: `DBEngineOptions.embeddingModel` → `embeddingUrl` に変更
- **config.ts**: `IndexingConfig` に `embeddingUrl?` 追加（オプショナル、デフォルト http://localhost:8080）
- **loader.ts**: embeddingUrl のマージ追加
- **server.ts**: `SEARCH_DOCS_DOCKER_EMBEDDING_URL` config fixation 追加

### Docker
- **entrypoint.sh**: MCPモードで外部Embedding Server自動検出（ping）→ 見つからなければローカル起動
- **Dockerfile**: `SEARCH_DOCS_DOCKER_EMBEDDING_URL` 環境変数追加

### テスト基盤
- **vitest.config.ts**: globalSetup追加（新規）
- **globalSetup.ts**: テスト前にembedding_server.pyを起動、テスト後に停止（新規）
- **db-engine.test.ts**: embeddingUrl指定に変更

## 設計判断

- **フォールバック無し**: embedding serverが応答しなければエラー（フォールバックでローカルモデルをロードしない）
- **自動検出はentrypoint.shのみ**: Pythonコード側に検出ロジックは入れない。インフラ層（entrypoint.sh）が検出してEMBEDDING_URL環境変数をセット
- **embeddingUrl オプショナル**: テストファイル大量修正を回避。DEFAULT_CONFIGで http://localhost:8080
- **RuriEmbeddingクラスは残す**: embedding_server.py が使用するため

## 検証結果

- `pnpm run build:all` 成功
- db-engine テスト 23/23 通過（embedding server事前起動で確認済み）
