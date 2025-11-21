---
"@search-docs/db-engine": patch
---

Python 3.14未満に制限（PyTorch torch.compile互換性のため）

PyTorch 2.9.1のtorch.compileがPython 3.14をサポートしていないため、requires-pythonを">=3.11,<3.14"に変更しました。この制限により、ModernBERTベースのRuri埋め込みモデルが正しく動作します。

PyTorch 2.10以降でPython 3.14サポートが安定したら、この制限を解除する予定です。
