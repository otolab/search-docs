# task47: インデックスファイル削除（purge）機能

## 目的

壊れたインデックスを廃棄して再構築するためのコマンドを追加する。
repair（部分修復）とは異なり、インデックスディレクトリごと削除する機能。

## 方針

- `storage.indexPath`（デフォルト: `.search-docs/index`）ディレクトリを削除
- CLI: `maintenance purge` コマンド追加（repairと並列）
- MCP: `maintenance_purge` ツール追加
- DBEngine不要（ファイルシステム操作のみ）

## 変更箇所

1. `packages/cli/src/commands/index/purge.ts` — 新規
2. `packages/cli/src/index.ts` — `index purge` サブコマンド追加
3. `packages/mcp-server/src/tools/index-purge.ts` — 新規（`index_purge` ツール）
4. `packages/mcp-server/src/tools/index.ts` — export追加
5. `packages/mcp-server/src/server.ts` — ツール登録

## 進捗

- [x] CLI実装（`index purge`）
- [x] MCP実装（`index_purge`）
- [x] ビルド・lint確認
