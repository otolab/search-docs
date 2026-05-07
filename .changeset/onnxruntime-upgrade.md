---
"@search-docs/db-engine": patch
---

onnxruntime を 1.20.0 → 1.25.1 に更新。CoreML EP の input dim > 16384 制限が解消され、embedding 層（語彙サイズ 102400）が GPU 実行可能に（494/624 → 599/624 ノード対応）。モデルパス解決からプロジェクトキャッシュ参照を削除。
