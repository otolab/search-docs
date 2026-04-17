# task38: Embedding ONNX化 + Ollama API互換

**作成日**: 2026-04-16
**状態**: 実装完了（残課題あり）
**関連Issue**: #69

## 背景

Docker イメージの Embedding 依存を torch (564MB) → ONNX Runtime (~50MB) に移行し、
API を Ollama `/api/embed` 互換にすることで外部 Ollama への接続も可能にする。

## 実装内容

### 新規ファイル
- `packages/db-engine/src/python/embedding_onnx.py` — ONNXEmbedding クラス

### 改修ファイル
- `embedding_server.py` — `/api/embed` (Ollama互換) 追加、`--runtime`/`--model-path` 引数
- `embedding.py` — RemoteEmbeddingModel を Ollama API に変更
- `worker.py` — init_model の /health フォールバック対応
- `Dockerfile` — torch → onnxruntime、ONNX モデルダウンロード
- `docker/entrypoint.sh` — ONNX ランタイム引数追加
- `packages/db-engine/pyproject.toml` — onnxruntime/transformers をデフォルト依存に
- `packages/types/src/config.ts` — embeddingModel デフォルト変更
- `globalSetup.ts` — テスト時は `--runtime=torch`

## テスト結果
- TypeScript ビルド: 全パッケージ成功
- db-engine テスト: 23/23 パス（Ollama `/api/embed` 経由で動作確認）
- Docker ビルド: 検証中

## 設計メモ

### API統一
- クライアント (RemoteEmbeddingModel) は常に Ollama `/api/embed` で通信
- 自前サーバでも外部 Ollama でも同じプロトコル
- レガシー `/encode` は互換のため残す

### ONNX モデル
- `sirasagi62/ruri-v3-30m-ONNX` (HuggingFace)
- ModernBert ベース、256d
- INT8/FP16 等の量子化版もあり

### ローカル開発
- pyproject.toml: onnxruntime がデフォルト依存
- torch は optional dependency (`[project.optional-dependencies] torch`)
- テストは `--runtime=onnx` + ローカルONNXモデル（`.cache/models/ruri-v3-30m-onnx`）
- torch はローカル環境からアンインストール済み

## 完了事項
- Docker イメージ: 2.54GB → 1.48GB（42%削減）
- ONNX CPU でのフルインデックス構築: 約5.5分（2782セクション）
- Docker Hub に push: `otolab/search-docs-mcp:latest`, `otolab/search-docs-mcp:0.1.0`
- ローカルテスト: ONNX ランタイムで 23/23 パス（torch 不要）

## TODO（残課題）

### Ollama 自動検出の改善
- entrypoint.sh で `/api/tags` による自動検出を実装したが、Ollama デフォルトポート (11434) の自動検出は一旦削除
- 理由: Ollama が ModernBERT (ruri-v3-30m) をまだサポートしていない（llama.cpp には入っているが Ollama 側の vendor bump 待ち）
- **対応時期**: Ollama が ModernBERT をサポートしたら自動検出を復活させる
- `keisuke-miyako/ruri-v3-30m-gguf-q8_0` (HuggingFace) は存在するが Ollama でロードエラー

### compose.yaml の更新
- healthcheck を `/health` → `/api/tags` に変更
- image を `ghcr.io/otolab/...` → `otolab/search-docs-mcp` に変更
- サービス名 `embedding-server` と entrypoint.sh の検出名 `search-docs-embedding` の不一致を修正

### Docker MCP のサーバ共有問題
- 現状: 各 MCP コンテナが独自の search-docs server + worker を起動
- 問題:
  - 同じプロジェクトに複数コンテナ → 同じインデックスDBに複数 worker が同時書き込み（データ破損リスク）
  - ファイル変更時に全コンテナの worker が一斉に embedding 処理（リソース浪費）
  - PID ファイルの競合
- 解決案: search-docs server をコンテナ外 or sidecar で1つ立て、MCP サーバはそこに接続するだけの構成にする
- compose.yaml を MCP server / search-docs server / embedding server の3サービス構成に分離する必要あり
