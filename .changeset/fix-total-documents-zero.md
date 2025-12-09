---
'@search-docs/db-engine': patch
---

totalDocumentsが0になるバグを修正

get_stats()関数でtable.to_lance()を使用していましたが、pylanceパッケージへの依存が必要でした。pyproject.tomlにpylance>=0.9.0を追加することで、totalDocumentsを正しく取得できるようになりました。
