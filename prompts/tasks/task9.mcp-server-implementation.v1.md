# Task 9: MCP Server実装

**作成日**: 2025-10-30
**状態**: 実装中
**推定工数**: 4-6時間
**優先度**: 高

## 目的

Claude Codeから直接search-docsを利用できるMCP Serverを実装する。

## 背景

- Task 8でインデックス状態管理システムが完成
- CLIとサーバの基本機能は実装済み
- Claude Code統合により、ドキュメント検索を直接会話から実行可能にする

## 参考実装

### 1. mode-controller MCP
- **パス**: `/Users/naoto.kato/Develop/otolab/ai-agent-prompts/agent-prompts/mcps/mode-controller/`
- **特徴**:
  - シンプルな構成（単一ファイル `src/server.ts`）
  - `@modelcontextprotocol/sdk` の使用パターン
  - ツール登録の基本パターン

### 2. coeiro-operator MCP
- **パス**: `/Users/naoto.kato/Develop/otolab/coeiro-operator/packages/mcp/`
- **特徴**:
  - 複雑な初期化処理（ConfigManager, OperatorManager等）
  - 多数のツール実装（15個以上）
  - エラーハンドリングとロギング

## 実装方針

### アーキテクチャ

```
packages/mcp-server/
├── src/
│   └── server.ts          # メインサーバ（単一ファイル）
├── package.json
├── tsconfig.json
└── README.md
```

### 依存関係

- `@modelcontextprotocol/sdk`: MCP SDK
- `@search-docs/client`: 既存のSearchDocsClient
- `commander`: CLIオプション解析
- `zod`: スキーマバリデーション

### 提供するツール

#### 1. `search`
**説明**: 文書検索を実行

**パラメータ**:
```typescript
{
  query: string;           // 検索クエリ
  depth?: number | number[]; // 検索深度（0-3）
  limit?: number;          // 結果数制限（デフォルト: 10）
  includeCleanOnly?: boolean; // Clean状態のみ検索
}
```

**レスポンス**:
```typescript
{
  results: SearchResult[];
  total: number;
  took: number;
}
```

#### 2. `get_document`
**説明**: 文書の全体または特定セクションを取得

**パラメータ**:
```typescript
{
  path: string;           // 文書パス
  sectionId?: string;     // セクションID（省略時は全体）
}
```

**レスポンス**:
```typescript
{
  path: string;
  content: string;
  metadata?: any;
}
```

#### 3. `index_status`
**説明**: インデックス状態を確認

**パラメータ**:
```typescript
{
  // パラメータなし
}
```

**レスポンス**:
```typescript
{
  totalDocuments: number;
  totalSections: number;
  dirtyCount: number;
  cleanCount: number;
  indexingInProgress: boolean;
}
```

### 初期化フロー

```typescript
1. コマンドライン引数の解析
   - --project-dir: プロジェクトディレクトリ（必須）
   - --config: 設定ファイルパス（オプション）

2. SearchDocsClientの初期化
   - サーバURL構築（config.jsonからポート取得）
   - 接続確認

3. MCPサーバの起動
   - StdioServerTransportで通信
   - ツール登録
```

### エラーハンドリング

- サーバ未起動時: わかりやすいエラーメッセージ
- 接続失敗時: リトライ機能
- タイムアウト: 適切な待機時間設定

## 実装ステップ

### Phase 1: パッケージ構造作成
- [ ] `packages/mcp-server/` ディレクトリ作成
- [ ] `package.json` 作成
- [ ] `tsconfig.json` 作成（Project References）
- [ ] ルート `package.json` に追加

### Phase 2: 基本サーバ実装
- [ ] `src/server.ts` 作成
- [ ] コマンドライン引数解析
- [ ] SearchDocsClient初期化
- [ ] MCPサーバ起動

### Phase 3: ツール実装
- [ ] `search` ツール
- [ ] `get_document` ツール
- [ ] `index_status` ツール

### Phase 4: テストと動作確認
- [ ] ビルド確認
- [ ] Claude Code統合テスト
- [ ] エラーケースのテスト

## 技術的な考慮事項

### プロジェクトディレクトリの解決

```bash
# MCP設定例
{
  "mcpServers": {
    "search-docs": {
      "command": "node",
      "args": [
        "/path/to/search-docs/packages/mcp-server/dist/server.js",
        "--project-dir",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### サーバURL構築

```typescript
// 1. プロジェクトディレクトリから設定ファイル読み込み
const configPath = path.join(projectDir, '.search-docs.json');
const config = await readConfig(configPath);

// 2. サーバURLを構築
const serverUrl = `http://${config.server.host}:${config.server.port}`;

// 3. SearchDocsClientを初期化
const client = new SearchDocsClient(serverUrl);
```

### 設定ファイルのデフォルト値

設定ファイルが存在しない場合:
```typescript
const defaultConfig = {
  server: {
    host: 'localhost',
    port: 24280
  }
};
```

## 完了条件

- [ ] MCPサーバが正常に起動する
- [ ] 3つのツールがすべて動作する
- [ ] Claude Codeから検索が実行できる
- [ ] エラーハンドリングが適切
- [ ] README.mdに利用方法を記載

## 参考ドキュメント

- @docs/client-server-architecture.md - MCP Server設計
- @packages/client/src/client.ts - SearchDocsClient実装
- mode-controller実装パターン
- coeiro-operator実装パターン

## メモ

### mode-controllerとの違い
- mode-controller: ファイルベースのモード管理
- search-docs: サーバとの通信が必要

### coeiro-operatorとの違い
- coeiro-operator: 複雑な状態管理と多数のツール
- search-docs: シンプルな検索特化

### 実装の焦点
- **シンプルさ**: 必要最小限のツールのみ
- **堅牢性**: サーバ未起動時のエラーハンドリング
- **使いやすさ**: Claude Codeからの自然な利用

---

**次のアクション**: Phase 1からスタート
