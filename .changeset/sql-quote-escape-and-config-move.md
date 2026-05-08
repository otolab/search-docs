---
"@search-docs/db-engine": patch
"@search-docs/config": patch
"@search-docs/types": patch
"@search-docs/server": patch
"@search-docs/cli": patch
"@search-docs/mcp-server": patch
---

fix: SQLフィルタのシングルクォートおよびLIKEメタ文字エスケープ (#96)

- worker.py に `_escape_sql()` / `_escape_like()` を追加し、全SQL文字列リテラルを安全にエスケープ
- シングルクォートを含むファイルパスでの検索・更新・削除が正しく動作するように修正

refactor: ConfigLoaderを @search-docs/config パッケージに分離 (#91)

- `@search-docs/types` から ConfigLoader / validateConfig / checkConfigDeprecations を新パッケージ `@search-docs/config` へ移動
- server, cli, mcp-server の import パスを更新
