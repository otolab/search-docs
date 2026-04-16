# task38: Embedding ONNX化 + Ollama API互換

**作成日**: 2026-04-16
**状態**: 実装中（Dockerビルド検証待ち）
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
- テストは `--runtime=torch` で既存の SentenceTransformer を使用
