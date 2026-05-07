# @search-docs/storage

## 1.0.22

### Patch Changes

- Updated dependencies [b46906e]
  - @search-docs/types@1.5.0

## 1.0.21

### Patch Changes

- Updated dependencies [33563c9]
  - @search-docs/types@1.4.3

## 1.0.20

### Patch Changes

- Updated dependencies [dccec8b]
  - @search-docs/types@1.4.2

## 1.0.19

### Patch Changes

- Updated dependencies [646485c]
  - @search-docs/types@1.4.1

## 1.0.18

### Patch Changes

- Updated dependencies [bb08dfd]
  - @search-docs/types@1.4.0

## 1.0.17

### Patch Changes

- 3361c2e: 全依存パッケージのバージョンを固定（Node.js/Python）
- Updated dependencies [3361c2e]
- Updated dependencies [49e53ea]
  - @search-docs/types@1.3.4

## 1.0.16

### Patch Changes

- Updated dependencies [f836ac2]
  - @search-docs/types@1.3.3

## 1.0.15

### Patch Changes

- Updated dependencies [6ecd3e6]
  - @search-docs/types@1.3.2

## 1.0.14

### Patch Changes

- Updated dependencies [fe67c66]
  - @search-docs/types@1.3.1

## 1.0.13

### Patch Changes

- Updated dependencies [7d87e38]
  - @search-docs/types@1.3.0

## 1.0.12

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.2.0

## 1.0.11

### Patch Changes

- Updated dependencies [691fccb]
  - @search-docs/types@1.1.0

## 1.0.10

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

## 1.0.9

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.11

## 1.0.8

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.10

## 1.0.7

### Patch Changes

- Updated dependencies [1402dc7]
  - @search-docs/types@1.0.9

## 1.0.6

### Patch Changes

- 54b20e9: Fix test failures and improve test stability

  - **db-engine**: Fix Python-TypeScript snake_case/camelCase conversion in search results. Task14 fields (startLine, endLine, sectionNumber) are now correctly converted.
  - **server**: Fix test timeout issues and type errors in test files. Increase beforeAll timeout to handle concurrent Python worker initialization.
  - **storage**: Add dist/ exclusion to vitest config to prevent duplicate test execution.
  - **db-engine**: Enable 2 previously skipped tests (findSectionsByPathAndHash, deleteSectionsByPathExceptHash).

## 1.0.5

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.8

## 1.0.4

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.7

## 1.0.3

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.6

## 1.0.2

### Patch Changes

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
