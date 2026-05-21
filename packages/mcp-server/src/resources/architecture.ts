export const ARCHITECTURE_CONTENT = `# アーキテクチャ概要

## プロセス構成

\`\`\`
MCP Server (stdio)
  ├─ in-process: SearchDocsServer (read-only)
  ├─ in-process: WatcherProcess (write, heartbeat調停)
  ├─ in-process: DBEngine
  └─ subprocess: Embedding Server (stateless, 共有可能)
           │
           ▼
       LanceDB (共有ストレージ)
\`\`\`

## コンポーネント

### MCP Server
- Claude Code統合、stdio通信
- SearchDocsServerをin-processで直接保持（HTTPデーモン不要）
- SearchDocsServiceインターフェイス経由でサーバ機能を利用

### JSON-RPC Server（search-docs server）
- \`search-docs server start\` コマンドで起動するHTTPサーバ
- 外部クライアントやrelated project接続向け
- MCPサーバからは使用されない（MCPはin-processで動作）

### Write Worker（WatcherProcess）
- ファイル監視（FileWatcher）とインデックス更新（IndexWorker）を担当
- Heartbeat調停により、複数インスタンス間で1つだけがmasterとして動作
- master以外はstandbyで待機し、masterがダウンすると自動昇格

### Embedding API Server
- Ollama API互換のHTTP埋め込みサーバ
- モデル: Ruri Embedding (cl-nagoya/ruri-v3-30m)
- ステートレスで複数プロセスから共有利用可能
- 自動検出: 外部URL → Docker service → host.docker.internal → ローカルspawn

### CLI
- \`server\`: サーバの起動・停止・状態確認・再起動
- \`search\`: 文書の検索（JSON/テーブル出力対応）
- \`index\`: インデックスの再構築・状態確認
- \`embedding\`: Embeddingサーバの起動・停止・状態確認
- \`config\`: 設定ファイルの初期化

## Docker構成

1イメージ・2モード:
- **MCPサーバモード**（デフォルト）: WatcherProcess内蔵。Embeddingサーバを自動検出し、見つからなければコンテナ内でCPU起動
- **Embeddingサーバモード**（\`--mode=embedding-server\`）: 複数MCPサーバから共有利用。メモリ節約に有効

GPU/CoreMLアクセラレーションを使う場合は、ホスト側で \`search-docs embedding start\` を起動。Docker MCPサーバが \`host.docker.internal\` 経由で自動検出します。

## データモデル

- **Document**: パス形式のキーで管理されるMarkdown文書
- **Section**: 見出し（H1-H4）ベースで分割。depth 0-3、トークン数閾値で再帰分割
- **SearchIndex**: LanceDB + Ruri Embeddingによるベクトル検索
- **Dirty管理**: 文書変更時にセクションをdirtyマーク → バックグラウンドワーカーが順次更新
`;
