# Task 26: Related Projects機能の設計と実装

## 目的

MCP Serverから複数のプロジェクトを検索できるようにする。

## 要件

### ユーザーストーリー
- メインプロジェクトを検索しながら、関連プロジェクトも検索したい
- 関連プロジェクトは明示的に指定した時のみ検索される（自動検索しない）
- プロジェクトごとに別のサーバが動いている前提

### 制約
- コマンドは増やしたくない（設定ファイルで管理）
- サーバの自動起動が必要
- 設定の複雑化を避ける

## 設計

### 1. 設定ファイル拡張

`.search-docs.json`に`relatedProjects`フィールドを追加：

```json
{
  "version": "1.0",
  "project": {
    "name": "search-docs",
    "root": "."
  },
  "relatedProjects": {
    "ai-agent-prompts": {
      "dir": "../ai-agent-prompts",
      "description": "Agent prompts and modes"
    },
    "sebas-chan": {
      "dir": "../sebas-chan",
      "description": "Reference architecture"
    }
  },
  // ... 既存の設定
}
```

### 2. 型定義の拡張

`packages/types/src/config.ts`:

```typescript
export interface RelatedProjectConfig {
  /** プロジェクトディレクトリ（相対パスまたは絶対パス） */
  dir: string;
  /** プロジェクトの説明（オプション） */
  description?: string;
}

export interface SearchDocsConfig {
  version: string;
  project: ProjectConfig;
  relatedProjects?: Record<string, RelatedProjectConfig>; // 追加
  files: FilesConfig;
  // ...
}
```

### 3. MCP Toolsの拡張

#### search ツール

```typescript
{
  query: string;
  project?: string;  // 追加：プロジェクト名（未指定=メインプロジェクト）
  depth?: number;
  limit?: number;
  // ...
}
```

**動作**:
- `project`未指定: メインプロジェクトを検索
- `project="ai-agent-prompts"`: 関連プロジェクトを検索
  1. 設定ファイルから`relatedProjects.ai-agent-prompts`を読み込む
  2. `dir`から設定ファイルのパスを解決
  3. 設定ファイルからポート番号を取得
  4. サーバが起動していなければ自動起動
  5. 検索を実行

#### get_document ツール

```typescript
{
  path?: string;
  sectionId?: string;
  project?: string;  // 追加
}
```

### 4. ServerManager拡張

複数プロジェクトのサーバ管理：

```typescript
class ServerManager {
  private servers: Map<string, ServerInfo> = new Map();

  async getOrStartServer(
    projectName: string,
    projectDir: string
  ): Promise<SearchDocsClient> {
    // キャッシュチェック
    // 設定ファイル読み込み
    // サーバ起動（必要なら）
    // クライアント返却
  }
}
```

### 5. ツール表示

利用可能なプロジェクト一覧を表示する方法：

#### 案A: list_projects ツール（新規）
```typescript
list_projects() → {
  main: { name: "search-docs", status: "running" },
  related: {
    "ai-agent-prompts": { status: "not_running", description: "..." },
    "sebas-chan": { status: "running", description: "..." }
  }
}
```

#### 案B: system_status に含める（既存拡張）
```typescript
system_status() → {
  // ...既存の情報
  relatedProjects: {
    "ai-agent-prompts": { status: "not_running", ... },
    "sebas-chan": { status: "running", ... }
  }
}
```

**推奨**: 案B（既存ツールの拡張）

### 6. エラーハンドリング

- 関連プロジェクトの設定ファイルが見つからない
- 関連プロジェクトのサーバ起動失敗
- 関連プロジェクトへの接続失敗

→ 明確なエラーメッセージで通知

## 実装順序

1. ✅ 設計策定（このドキュメント）
2. 型定義の拡張（`packages/types/src/config.ts`）
3. ConfigLoaderの拡張（関連プロジェクト解決）
4. ServerManagerの拡張（複数サーバ管理）
5. search/get_documentツールの拡張
6. system_statusツールの拡張
7. テストの作成
8. ドキュメントの更新

## 使用例

### Claude Codeでの使い方

```
ユーザー: ai-agent-promptsプロジェクトでoperator modeを検索して

Claude: [searchツールを使用]
        query: "operator mode"
        project: "ai-agent-prompts"

→ 自動的にai-agent-promptsのサーバが起動され、検索が実行される
```

### 設定例

```json
{
  "version": "1.0",
  "project": {
    "name": "search-docs",
    "root": "."
  },
  "relatedProjects": {
    "prompts": {
      "dir": "../ai-agent-prompts",
      "description": "Claude Code prompts and modes"
    },
    "reference": {
      "dir": "../sebas-chan",
      "description": "Architecture reference (LanceDB + Ruri)"
    }
  },
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  }
}
```

## 注意点

- 関連プロジェクトのサーバは検索時に自動起動されるが、自動停止はしない
- ポート番号は各プロジェクトの設定ファイルから取得（衝突の心配なし）
- プロジェクト名は設定ファイルのキー（短くてわかりやすい名前を推奨）

## TODO

- [ ] 型定義の拡張
- [ ] ConfigLoaderの拡張
- [ ] ServerManagerの拡張
- [ ] ツールの拡張
- [ ] テスト
- [ ] ドキュメント
