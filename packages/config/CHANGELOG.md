# @search-docs/config

## 1.1.0

### Minor Changes

- 5f70f6f: Respect .gitignore during file watching and add the clearer respectGitignore setting while preserving compatibility with ignoreGitignore. Serialize indexing and deletion, reconcile missing documents at startup, and improve shutdown and recovery of indexing services.

### Patch Changes

- Updated dependencies [5f70f6f]
  - @search-docs/types@1.6.0

## 1.0.2

### Patch Changes

- 61328c8: Release Publish で npm を GitHub Release より先に実行する CI 修正のパッチリリース
- Updated dependencies [61328c8]
  - @search-docs/types@1.5.2

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
