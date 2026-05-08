# @search-docs/config

## 1.0.1

### Patch Changes

- 0c8e22f: fix: SQL フィルタのシングルクォートおよび LIKE メタ文字エスケープ (#96)

  - worker.py に `_escape_sql()` / `_escape_like()` を追加し、全 SQL 文字列リテラルを安全にエスケープ
  - シングルクォートを含むファイルパスでの検索・更新・削除が正しく動作するように修正

  refactor: ConfigLoader を @search-docs/config パッケージに分離 (#91)

  - `@search-docs/types` から ConfigLoader / validateConfig / checkConfigDeprecations を新パッケージ `@search-docs/config` へ移動
  - server, cli, mcp-server の import パスを更新

- Updated dependencies [0c8e22f]
  - @search-docs/types@1.5.1
