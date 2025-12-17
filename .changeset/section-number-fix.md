---
"@search-docs/server": minor
"@search-docs/db-engine": minor
"@search-docs/mcp-server": minor
---

fix: セクション番号の表示問題を修正 (Issue #30)

**破壊的変更**: データベース構造の変更により、インデックスの再構築が必要です。

## 問題

get_outlineでセクション番号が「1.1: Level 1」のように、H1が1.1から始まっていました。

## 原因

document root (depth=0) とH1 (depth=1) が同じsectionNumber `[1]`を持っていたため、表示が重複していました。

## 修正内容

- **データ層**: document rootのsectionNumberを`[]`（空配列）に変更
- **表示層**: 空のsectionNumberを"root"として表示
- **テスト**: 包括的なsectionNumber検証テストを追加

## 影響

- **データベース**: sectionNumberの形式が変更されたため、インデックスの再構築が必要
- **表示**: セクション番号が正しく表示されるようになります
  - 以前: "1.1: Level 1"
  - 修正後: "1: Level 1"
