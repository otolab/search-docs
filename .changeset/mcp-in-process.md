---
"@search-docs/types": patch
"@search-docs/server": patch
"@search-docs/client": patch
"@search-docs/mcp-server": patch
"@search-docs/db-engine": patch
---

MCPサービスをin-process化し、関連プロジェクトをURL接続に限定

- SearchDocsServiceインターフェイスを追加し、in-processとHTTPアクセスを透過的に扱えるように
- MCPサーバがSearchDocsServerインスタンスを直接保持する構成に変更（HTTPデーモンspawn廃止）
- RelatedProjectConfigからdir指定を削除し、url必須に変更
- db-engineのget_statsで内部API(_dataset)を公開API(to_lance())に修正
- lancedb 0.25.3 → 0.30.2へアップデート（Lance v3.0対応）
- Python依存を全てバージョン固定（サプライチェーン対策）
- torch/sentence-transformers依存を削除（ONNX移行済み）
