# @search-docs/client

## 1.0.15

### Patch Changes

- Updated dependencies [7d87e38]
  - @search-docs/types@1.3.0

## 1.0.14

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.2.0

## 1.0.13

### Patch Changes

- Updated dependencies [691fccb]
  - @search-docs/types@1.1.0

## 1.0.12

### Patch Changes

- **PID ファイル競合状態の修正とビルドプロセス改善**

  **修正内容**:

  1. **server: PID ファイル競合状態の修正**

     - デーモン起動時に自分自身の PID を除外するロジックを追加
     - `existingPid.pid !== process.pid` チェックを追加
     - サーバプロセスが自分自身を「既に起動中」と誤認する問題を解決

  2. **すべてのパッケージ: prepublishOnly スクリプト追加**
     - npm publish 時に自動的にビルドを実行
     - 古いビルド成果物が誤って公開される問題を防止
     - 一貫性のあるリリースプロセスを確保

  **修正された問題**:

  - デーモンモードでのサーバ起動タイムアウト
  - npm publish 時の古いコードの公開

  **Breaking Changes**: なし

- Updated dependencies
  - @search-docs/types@1.0.12

## 1.0.11

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.10

## 1.0.9

### Patch Changes

- Updated dependencies [1402dc7]
  - @search-docs/types@1.0.9

## 1.0.8

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.6

## 1.0.5

### Patch Changes

- 9b5820a: 検索結果に startLine/endLine/sectionNumber フィールドを追加

  検索結果に文書内の位置情報を追加し、検索結果からソースファイルの該当箇所を特定できるようにしました。

  **主な変更**:

  - Section 型に 3 つの新フィールドを追加（startLine, endLine, sectionNumber）
  - MarkdownSplitter で行番号とセクション番号を自動生成
  - Python-TypeScript 変換層で新フィールドを変換
  - CLI 出力に位置情報を表示
  - MCP Server で新フィールドを提供
  - Python 側でフィールドのバリデーションと型変換を追加（null 値を防止）

  **影響範囲**:

  - 既存のインデックスは再構築が必要です（`search-docs index rebuild`または`.search-docs/index`を削除してサーバ再起動）

- Updated dependencies [9b5820a]
  - @search-docs/types@1.0.5

## 1.0.1

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.1

## 1.0.0

### Major Changes

- Initial release of search-docs - Local document vector search system

  ## Features

  - 🔍 Vector search for Markdown documents using LanceDB
  - 📝 Automatic document sectioning (depth 0-3)
  - 🚀 Client-server architecture with JSON-RPC
  - 🐕 CLI tool for easy document searching
  - 🤖 MCP Server for Claude Code integration
  - 🇯🇵 Optimized for Japanese with Ruri Embedding Models
  - 📦 Complete TypeScript + Python hybrid implementation

  ## Packages

  - **@search-docs/cli** - Command-line interface
  - **@search-docs/client** - TypeScript client library
  - **@search-docs/server** - Search server
  - **@search-docs/mcp-server** - MCP Server for Claude Code
  - **@search-docs/storage** - Document storage
  - **@search-docs/db-engine** - LanceDB vector search engine
  - **@search-docs/types** - TypeScript type definitions

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.0
