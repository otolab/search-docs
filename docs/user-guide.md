# 🐕️ search-docs ユーザーガイド

search-docsの包括的な使用方法ガイドです。

## 目次

- [基本的な概念](#基本的な概念)
- [始め方](#始め方)
- [基本的な使い方](#基本的な使い方)
- [設定ファイル](#設定ファイル)
- [CLIコマンド](#cliコマンド)
- [トラブルシューティング](#トラブルシューティング)
- [FAQ](#faq)

---

## 基本的な概念

search-docsを使う前に、基本的な構成要素を理解しましょう。

### Document（文書）

**Document**は、プロジェクト内の`.md`ファイルです。

- **識別**: ファイルパスで識別
- **変更検知**: ファイルのハッシュ値で変更を検知
- **自動インデックス**: ファイルウォッチャーが変更を自動検知

### Section（セクション）

**Section**は、Documentを見出しごとに分割した意味のある単位です。

- **depth 0**: 文書全体
- **depth 1**: H1見出し単位
- **depth 2**: H2見出し単位
- **depth 3**: H3見出し単位

**分割の仕組み**:
1. 見出し（H1〜H4）で機械的に分割
  - depth 1はdepth 2, 3の内容を含みます
  - ピッタリの内容があれば深い階層のスコアが高く、曖昧な一致は浅い階層がヒットします
2. トークン数が`maxTokensPerSection`を超える場合、再帰的に分割
3. 設定により調整可能（デフォルト: depth 3まで）

これにより、「この章のこの節」をピンポイントで検索できます。

**設定例**:
```json
{
  "indexing": {
    "maxDepth": 3,
    "maxTokensPerSection": 2000
  }
}
```

### Dirty管理

**Dirty**は、インデックスが最新でないSectionの状態です。

**Dirtyになるタイミング**:
- ファイルが変更されたとき
- ファイルが新規作成されたとき
- 設定ファイルが変更されたとき

**Dirtyの解消**:
- バックグラウンドワーカーが自動的に再インデックス
- `index rebuild`コマンドで手動再インデックス

**検索への影響**:
- デフォルトでは、DirtyなSectionも検索結果に含まれる
- `--clean-only`オプションで、Clean（最新）なSectionのみ検索可能

### Index（インデックス）

**Index**は、Sectionの Vector検索インデックスです。

- **LanceDB**: Vector databaseとして使用
- **Ruri Embedding**: 日本語最適化された埋め込みモデル
- **256次元**: ベクトル次元数（高速かつ高精度）

**インデックス戦略**:
- **BTREE**: 低カーディナリティ（document_path等）
- **BITMAP**: 高カーディナリティ（status, is_dirty等）
- **前方一致検索**: includePaths/excludePathsで効率的に絞り込み

### Server（サーバ）

**Server**は、プロジェクトごとに起動される検索サーバです。

**主な機能**:
- **DocumentStorage**: ファイルの変更検知と永続化
- **SearchIndex**: LanceDBによるVector検索
- **IndexWorker**: バックグラウンドでの自動再インデックス
- **ファイルウォッチャー**: リアルタイムでファイル変更を検知

**プロジェクト独立性**:
- 各プロジェクトで独立したサーバとインデックス
- ポート番号で区別
- 複数プロジェクトを同時に使用可能

**ファイル監視**:
- chokidarによるリアルタイム監視
- debounce処理（デフォルト1秒）で連続変更を効率的に処理
- 変更検知後、該当Documentを自動的にDirtyにマーク

**バックグラウンド更新**:
- IndexWorkerが定期的に（デフォルト5秒間隔）Dirtyセクションを処理
- 古いものから順次更新（created_at昇順）
- 最大同時処理数（デフォルト3）で負荷を制御

---

## 始め方

search-docsを始める方法は3つあります：

### 🚀 方法1: Claude Code + Docker版（推奨）

**ランタイム依存（Node.js, Python, uv）を排除し、セキュアな境界で実行**できます。

```bash
docker run --rm -i \
  -v .:/workspace:ro \
  -v ./.search-docs:/workspace/.search-docs \
  otolab/search-docs-mcp:latest
```

**注**: Docker MCP カタログに登録完了後は `docker mcp run search-docs` でも利用可能になります。

詳細: **[クイックスタート - Claude Code](./quick-start.md#方法1-claude-codeで試す30秒)** | **[Docker構成ガイド](./docker-deployment.md)**

### 🔧 方法2: Claude Code + npm/npx版（Docker環境がない場合）

Docker環境がない場合の代替手段です。

```bash
claude mcp add npx -- -y @search-docs/mcp-server
```

詳細: **[クイックスタート - Claude Code](./quick-start.md#方法1-claude-codeで試す30秒)**

### 💻 方法3: CLIツールとして使う

コマンドラインから直接使いたい場合。

詳細: **[クイックスタート - CLI](./quick-start.md#方法2-cliツールで試す5分)**

---

## 初回セットアップ（CLI利用者向け）

### インストール

**オプション1**: npxで直接実行（インストール不要）

```bash
# インストール不要
npx @search-docs/cli server start
```

**オプション2**: グローバルインストール

```bash
npm install -g @search-docs/cli
```

### 設定ファイルの作成

```bash
cd /path/to/your/project
npx @search-docs/cli config init
```

`.search-docs/config.json` が作成されます。既存の設定がある場合はデフォルトでは変更されないため、上書きする場合は `--force` を指定してください。

または手動で `.search-docs.json` を作成：

```json
{
  "version": "1.0",
  "files": {
    "sources": ["**/*.md"],
    "exclude": ["**/node_modules/**"]
  }
}
```

詳細: [設定ファイル](#設定ファイル)セクション

## 基本的な使い方

### 1. サーバの起動

```bash
# フォアグラウンドで起動
search-docs server start

# バックグラウンド（デーモン）で起動
search-docs server start

# ログファイルを指定
search-docs server start --log .search-docs/server.log
```

### 2. サーバの状態確認

```bash
search-docs server status
```

出力例：
```
Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:  Running
PID:     12345
Port:    24280
Project: my-project
Started: 2025-01-30T12:00:00.000Z
```

### 3. 文書の検索

```bash
# 基本的な検索
search-docs search "検索キーワード"

# depth指定（指定した深度まで検索）
search-docs search "検索キーワード" --depth 1

# 結果数を指定
search-docs search "検索キーワード" --limit 20

# JSON形式で出力
search-docs search "検索キーワード" --format json

# Cleanなセクションのみ検索
search-docs search "検索キーワード" --clean-only

# プレビュー行数とパスフィルタを指定
search-docs search "検索キーワード" --preview-lines 10 --include-path docs/ --exclude-path docs/internal/
```

#### 検索結果の形式

検索結果には以下の情報が含まれます：

```json
{
  "id": "section-uuid",
  "documentPath": "docs/architecture.md",
  "documentHash": "abc123...",
  "heading": "Vector検索エンジン",
  "depth": 2,
  "content": "セクションの本文...",
  "score": 0.95,
  "isDirty": false,
  "tokenCount": 150,
  "startLine": 42,
  "endLine": 68,
  "sectionNumber": [1, 2, 1]
}
```

**主要フィールド**:
- `documentPath`: 文書のパス
- `heading`: セクションの見出し
- `depth`: セクションの深度（0-3、0は文書全体）
- `content`: セクションの本文
- `score`: 検索スコア（高いほど関連性が高い）
- `isDirty`: セクションが最新かどうか

**文書内位置情報** (v1.0.4以降):
- `startLine`: セクションの開始行番号
- `endLine`: セクションの終了行番号
- `sectionNumber`: セクション番号の配列（例: `[1, 2, 1]` は「第1章 > 第2節 > 第1項」）

これらの情報を使って、検索結果から元の文書の該当箇所を正確に特定できます。

### 4. インデックスの管理

```bash
# インデックス状態の確認
search-docs index status

# インデックスの再構築（全文書）
search-docs index rebuild

# 特定のファイルのみ再構築
search-docs index rebuild docs/README.md AGENTS.md

# 強制的に再インデックス（ハッシュチェック無視）
search-docs index rebuild --force
```

### 5. サーバの停止

```bash
search-docs server stop
```

## 設定ファイル

設定ファイルの詳細説明です。

### 配置場所

以下の順で検索されます：
1. `.search-docs.json`（推奨）
2. `search-docs.json`
3. `.search-docs/config.json`（`config init` の生成先）

### 設定項目

#### project

プロジェクト情報を定義します。

```json
{
  "project": {
    "name": "my-project",
    "root": "."
  }
}
```

- `name`: プロジェクト名
- `root`: プロジェクトルートディレクトリ（通常は `.`）

#### files

インデックス対象のファイルを定義します。

```json
{
  "files": {
    "sources": ["**/*.md"],
    "exclude": ["**/node_modules/**"],
    "respectGitignore": true
  }
}
```

- `sources`: 監視対象のglobパターン（推奨、v1.8.6以降）
- `include`: `sources`の旧名称（後方互換のため動作するが非推奨）
- `exclude`: 除外するglobパターン
- `respectGitignore`: ルートの `.gitignore` を適用するか（既定値 `true`）。`false` では適用しません。
- `ignoreGitignore`: 非推奨の旧名です。真偽値を変えずに `respectGitignore` に名前を変更してください。両方を同時に指定するとエラーになります。

`.gitignore` は初期同期時と監視開始時に読み込みます。監視中の変更は監視を再開すると反映され、変更だけでは既存の索引の削除や再走査は行いません。除外対象になった文書も、監視中に実ファイルを削除すると索引とストレージから削除されます。

**sourcesパターンの監視方式**（v1.8.6以降）:

`sources`パターンの `**` 有無により、shallow（直下のみ）/deep（再帰的）監視を自動判定します。

| パターン | 監視方式 | 意味 |
|---------|---------|------|
| `docs/**` | deep | docs/ 以下を再帰的に監視 |
| `docs/**/*.md` | deep | 同上 |
| `*.md` | shallow | ルート直下のみ監視 |
| `docs/*` | shallow | docs/ 直下のみ監視 |
| `README.md` | shallow | ルート直下の特定ファイル |

**glob中間パターンの展開**:

`systems/*/docs/**` のように中間にglobを含むパターンは、起動時にディレクトリ走査で実パスに展開されます。

```json
{
  "files": {
    "sources": ["systems/*/docs/**"]
  }
}
```

→ `systems/app-a/docs/**`, `systems/app-b/docs/**` に展開

**優先順位**:
1. `exclude`パターン（最優先）
2. `.gitignore`（`respectGitignore: true`の場合）
3. `sources`パターン

#### indexing

インデックス化の設定です。

```json
{
  "indexing": {
    "maxTokensPerSection": 2000,
    "minTokensForSplit": 100,
    "maxDepth": 3,
    "vectorDimension": 256,
    "embeddingModel": "cl-nagoya/ruri-v3-30m"
  }
}
```

- `maxTokensPerSection`: セクションの最大トークン数
- `minTokensForSplit`: 分割する最小トークン数
- `maxDepth`: 最大分割深度（0-3）
- `vectorDimension`: ベクトル次元数（既定256）。Ollamaではモデルが対応する次元を指定
- `embeddingModel`: 情報表示用のモデル名。Ollamaの選択には環境変数 `EMBEDDING_MODEL` を使用

#### 外部 embedding provider

`indexing.embedding` を明示すると、外部 provider に接続できない場合はエラーで停止し、ローカルプロセスを起動しません。OpenAI 互換 API の例です。

```json
{
  "indexing": {
    "vectorDimension": 1536,
    "embedding": {
      "provider": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "text-embedding-3-small",
      "apiKey": "${env:OPENAI_API_KEY}"
    }
  }
}
```

`provider` 以外の項目は `providerOptions` オブジェクト内にまとめることもできます。`apiKey` は環境変数または Cloud Secrets から供給してください。省略すると `EMBEDDING_API_KEY` を使用します。`baseUrl` は `/v1` までを含み、プログラムが `/embeddings` を追加します。URL に認証情報・クエリ・フラグメントは指定できません。OpenAI 互換 provider では認証情報の転送を防ぐため、HTTP リダイレクトを追跡せずエラーとして扱います。`ollama-compat` の場合は `url` と `model`（または `EMBEDDING_MODEL`）を指定します。`builtin` は従来のサーバ検出・起動を使用します。

`EMBEDDING_PROVIDER` を設定するとファイルの provider 設定より優先され、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_API_KEY` で外部 provider を設定できます。プロバイダ固有の項目は JSON オブジェクトの `EMBEDDING_OPTIONS` に指定できます。従来の `EMBEDDING_URL` は明示 provider を指定しない場合に厳格な接続先となり、従来の `indexing.embeddingUrl` は失敗時に自動検出へ進みます。

明示的な外部 provider は `vectorDimension` をリクエストの `dimensions` に渡し、返却ベクトルが同じ次元でなければエラーになります。API とモデルがその次元指定に対応している必要があります。従来の builtin は互換性のため `/health` が返す次元を優先します。provider、モデル、次元、接続先を変更する場合は、稼働中のサーバを停止して索引を再構築してください。OpenAI 互換では接続先のハッシュを索引 identity に記録し、変更を検出すると再構築を要求します。接続先を記録していない旧形式の OpenAI 互換索引も、安全のため再構築が必要です。`search-docs embedding status` は明示的な外部 provider へ推論リクエストを送り、接続と次元を確認します。

外部サーバの優先順位、Ollamaの利用方法とモデル変更時の再作成については [Docker構成ガイド](docker-deployment.md#ollamaをdocker-mcpから使う) を参照してください。

#### search

検索動作の設定です。

```json
{
  "search": {
    "defaultLimit": 10,
    "maxLimit": 100,
    "includeCleanOnly": false
  }
}
```

- `defaultLimit`: デフォルトの検索結果数
- `maxLimit`: 最大検索結果数
- `includeCleanOnly`: Cleanなセクションのみ検索するか

#### server

サーバの設定です。

```json
{
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  }
}
```

- `host`: バインドするホスト
- `port`: ポート番号
- `protocol`: 通信プロトコル（現在は`json-rpc`のみ）

#### storage

データ保存場所の設定です（通常は変更不要）。

```json
{
  "storage": {
    "documentsPath": ".search-docs/documents",
    "indexPath": ".search-docs/index",
    "cachePath": ".search-docs/cache"
  }
}
```

#### watcher

ファイル監視の設定です。

```json
{
  "watcher": {
    "enabled": true,
    "debounceMs": 1000
  }
}
```

- `enabled`: ファイル監視を有効にするか
- `debounceMs`: 変更検知の遅延時間（ミリ秒）

#### worker

バックグラウンドワーカーの設定です。

```json
{
  "worker": {
    "enabled": true,
    "interval": 5000,
    "maxConcurrent": 3
  }
}
```

- `enabled`: ワーカーを有効にするか
- `interval`: 処理間隔（ミリ秒）
- `maxConcurrent`: 最大同時処理数

## CLIコマンド

詳細なコマンドリファレンスは [cli-reference.md](./cli-reference.md) を参照してください。

### server コマンド

| コマンド | 説明 |
|---------|------|
| `server start` | サーバを起動 |
| `server stop` | サーバを停止 |
| `server status` | サーバの状態を確認 |
| `server restart` | サーバを再起動 |

### search コマンド

```bash
search-docs search <query> [options]
```

| オプション | 説明 |
|-----------|------|
| `--limit <n>` | 最大結果数（デフォルト: 10） |
| `--depth <depth>` | 最大深度（例: 1） |
| `--format <format>` | 出力形式（text, json） |
| `--clean-only` | Dirtyセクションを除外 |
| `--preview-lines <n>` | text出力のプレビュー最大行数（デフォルト: 5） |
| `--include-path <path>` | 検索対象に含めるドキュメントパス（前方一致、繰り返し可） |
| `--exclude-path <path>` | 検索対象から除外するドキュメントパス（前方一致、繰り返し可） |
| `--server <url>` | サーバURL |

### index コマンド

| コマンド | 説明 |
|---------|------|
| `index rebuild [paths...]` | インデックスを再構築 |
| `index status` | インデックスの状態を確認 |

### embedding コマンド

Embeddingサーバの起動・停止・状態確認を行います。プロジェクト横断で共有利用でき、GPU/CoreMLアクセラレーションに対応しています。

| コマンド | 説明 |
|---------|------|
| `embedding start [options]` | Embeddingサーバを起動 |
| `embedding download [options]` | Embeddingモデルを事前取得（サーバは起動しない） |
| `embedding stop [options]` | Embeddingサーバを停止 |
| `embedding status [options]` | Embeddingサーバの状態を確認 |

**主なオプション**:
- `--port <port>`: ポート番号（startは24281、status/stopはPIDファイルのport、なければ24281）
- `-f, --foreground`: フォアグラウンドで起動
- `--runtime <runtime>`: `onnx`（デフォルト、GPU/CoreML対応）または `torch`
- `--dimension <dim>`: ベクトル次元数（デフォルト: 256）
- `--ready-timeout <ms>`: 初回モデル取得を含む readiness 待ち時間（ミリ秒、既定: 600000）
- `SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS`: `embedding start` と `server start` の待ち時間を共通設定
- `embedding download`: Hugging Face の標準キャッシュにモデルを事前取得。`--model <repo>` で取得先リポジトリを指定できます
- `embedding stop --port <port>`: PIDファイルのない外部サーバをポート指定で停止
- `embedding stop --force`: SIGKILLで強制停止
- `embedding status --verbose`: PID、LISTEN、liveness、readinessなどの診断を表示
- `embedding status --repair`: stale PIDファイルを削除して再確認
- `embedding status --probe`: 実際の推論パスを確認（`--timeout <ms>`でタイムアウト指定）

詳細は [CLIリファレンス - embedding コマンド](./cli-reference.md#embedding-コマンド) を参照してください。

初回起動時は Hugging Face からモデルを取得するため、ネットワーク速度に応じて数分かかることがあります。起動前にダウンロードしておく場合:

```bash
search-docs embedding download
search-docs embedding start
```

### config コマンド

| コマンド | 説明 |
|---------|------|
| `config init` | `.search-docs/config.json` を初期化。既存設定はデフォルトで保持し、上書きには `--force` を指定 |

---

## Claude Code統合

Claude Codeで使う場合の詳細は以下を参照してください：

- **[クイックスタート - Claude Code](./quick-start.md#方法1-claude-codeで試す30秒)** - 30秒で始める
- **[MCP統合ガイド](./mcp-integration.md)** - 詳しい使い方

**利用可能なツール**:
- `search`: 文書検索
- `get_document`: 文書取得
- `get_outline`: 文書のアウトライン取得
- `index_status`: インデックス状態確認
- `diagnose_duplicates`: 重複したセクション木の候補を読み取り専用で検査
- その他 - [MCP統合ガイド](./mcp-integration.md)参照

`diagnose_duplicates` はパラメータなしで実行し、固定した索引バージョンのセクションを検査します。同じパスと文書ハッシュの中で、内容・位置・親子関係が一致する完全な木を候補として表示します。結果には検査したバージョン、行数、判定不能なグループ、表示を省略した件数を含みます。パスとルート ID は表示されるため、結果の共有時は情報の取り扱いに注意してください。

検査は最大 50,000 行または取得した Arrow データの合計が 64 MiB を超えると中断し、不完全と表示します。各バッチは最大1行ですが、1行自体が 64 MiB を超える場合もあります。この値はプロセスのメモリ上限やストレージからの読み取り量の上限ではありません。最大100候補、各候補のルート ID は10件まで表示します。部分的な重複や旧形式などは判定できない場合があり、候補なしは重複が存在しない保証ではありません。

検査は heartbeat を処理する DB ワーカーとは別のプロセスで実行し、30秒を超えた場合は終了を試みて不完全と報告します。ただし共有ストレージの停止・高負荷やシステム全体の資源不足で heartbeat が遅れる可能性は残り、任意のストレージ障害に対する takeover 防止は保証しません。検査中に索引が変わっても結果は固定時点のもので、現在の状態と異なる場合があります。削除・再索引・修復は行いません。`maintenance_repair` は正常に読める重複の除去には対応しておらず、同一ハッシュの重複は `index rebuild --force` でも解消できません。

---

## トラブルシューティング

### サーバが起動しない

**症状**: `search-docs server start`でエラーが発生する

**解決方法**:

1. **ポート競合の確認**
   ```bash
   lsof -i :24280
   ```
   使用中の場合は別のポートを指定：
   ```bash
   search-docs server start --port 24281
   ```

2. **古いPIDファイルの削除**
   ```bash
   rm .search-docs/server.pid
   ```

3. **Python環境の確認**
   ```bash
   uv sync
   ```

### 検索結果が返ってこない

**症状**: `search-docs search`で結果が0件

**原因**:
- インデックスが作成されていない
- サーバが起動していない

**解決方法**:

1. サーバの状態確認
   ```bash
   search-docs server status
   ```

2. インデックスの状態確認
   ```bash
   search-docs index status
   ```

3. インデックスの再構築
   ```bash
   search-docs index rebuild
   ```

### ファイル変更が反映されない

**症状**: ファイルを更新しても検索結果に反映されない

**原因**:
- ファイルウォッチャーが無効
- IndexWorkerがDirtyセクションを処理中

**解決方法**:

1. 設定ファイルを確認（`watcher.enabled: true`か確認）

2. インデックス状態を確認
   ```bash
   search-docs index status
   ```
   `Dirty`の数をチェック

3. 手動で再構築
   ```bash
   search-docs index rebuild <file-path>
   ```

### メモリ使用量が多い

**症状**: サーバのメモリ使用量が大きい

**原因**:
- 大量の文書をインデックス化している
- 埋め込みモデルがメモリに常駐

**解決方法**:

1. 不要なファイルを除外
   `.search-docs.json`の`files.exclude`を調整

2. `maxDepth`を下げる（セクション数を減らす）
   ```json
   {
     "indexing": {
       "maxDepth": 1
     }
   }
   ```

3. サーバを定期的に再起動

---

## 制約事項と注意点

### 現在の制約

- **ファイル形式**: Markdownファイル（`.md`）のみ対応
- **言語最適化**: 日本語文書に最適化（英語も使用可能だが精度は低下）
- **実行環境**: ローカル実行のみ（クラウド非対応）
- **同時起動**: 同じポートで複数サーバは起動不可

### パフォーマンス関連

**メモリ使用量**:
- 埋め込みモデルがメモリに常駐（約120MB）
- 大量の文書をインデックス化する場合、メモリ使用量が増加
- 対策: 不要なファイルを`exclude`パターンで除外

**GPU対応**:
- GPUを使用することでVector化処理を大幅に高速化（数倍〜数十倍）
- Apple Silicon（M1/M2/M3）は自動的にMPS GPUを使用
- NVIDIA GPU: CUDA Toolkit必要
- 詳細: README.mdのGPU対応セクション参照

**インデックスサイズ**:
- 通常、元のファイルサイズの1-2倍程度
- ベクトルデータと検索インデックスを含む
- SSDの使用を推奨

### セキュリティ関連

**データの保存場所**:
- すべてのデータはローカルに保存（`.search-docs/`ディレクトリ）
- 外部への送信は一切なし（初回の埋め込みモデルダウンロードを除く）
- プライベート文書も安全に扱える

**バージョン管理**:
- `.search-docs.json`はバージョン管理に含めることを推奨
- `.search-docs/`ディレクトリは`.gitignore`に追加すること

---

## FAQ

### Q: どのファイル形式をサポートしていますか？

A: 現在はMarkdown (`.md`) ファイルのみサポートしています。将来的には他のテキスト形式も対応予定です。

### Q: 複数のプロジェクトで使えますか？

A: はい。各プロジェクトで独立したサーバを起動できます。ポート番号を変更してください。

### Q: オフラインで使えますか？

A: はい。すべての処理はローカルで完結します。初回のみ埋め込みモデルのダウンロードが必要です。

### Q: 英語の文書でも使えますか？

A: 使えますが、日本語文書に最適化されています。英語の場合は別の埋め込みモデルの使用を検討してください。

### Q: インデックスの更新は自動ですか？

A: はい。ファイルウォッチャーが変更を検知し、バックグラウンドで自動的にインデックスを更新します。

### Q: プライベートな文書を扱っても安全ですか？

A: はい。すべてのデータはローカルに保存され、外部に送信されることはありません。

### Q: 設定ファイルをバージョン管理に含めるべきですか？

A: はい。`.search-docs.json`はプロジェクト固有の設定なので、バージョン管理に含めることを推奨します。ただし、`.search-docs/`ディレクトリは`.gitignore`に追加してください。

### Q: インデックスのサイズはどのくらいになりますか？

A: 文書の量によりますが、通常は元のファイルサイズの1-2倍程度です。ベクトルデータと検索インデックスが含まれます。

### Q: パフォーマンスを向上させるには？

A: 以下の方法があります：
- 不要なファイルを`exclude`パターンで除外
- `maxDepth`を下げる（セクション数を減らす）
- `maxTokensPerSection`を調整
- SSDを使用する

## 次のステップ

- [クイックスタート](./quick-start.md) - 5分で試す
- [CLIリファレンス](./cli-reference.md) - 全コマンドの詳細
- [MCP統合ガイド](./mcp-integration.md) - Claude Code統合
- [開発ガイド](./development.md) - 開発に参加する（未作成）


### 起動時の削除照合

writer は監視を開始した後、保存済み文書・索引・未完了 request を確認します。現在の設定で監視できる文書が元の場所に存在しないと確かめられた場合は、対応する search-docs の文書コピーと現行索引を削除し、古い未完了 request を取り消します。元文書は削除しません。`storage.documentsPath` は、`.search-docs` の外に設定した場合も search-docs 専用の管理領域として使用してください。

現在の設定から対象外になった文書や除外、監視・走査・アクセスの失敗、リンク切れ、監視できるか分からないリンク、保存先が管理領域外へ解決される場合などは削除を保留します。索引だけが残り、管理コピーの親ディレクトリがないネストパスも保留します。保留中は古い索引や文書コピーが残り、検索に表示されることがあります。`index_status` に照合の進行状況・保留理由や監視エラーが表示されます。writer の状態を取得できない場合も、その旨を表示します。設定やアクセスを修正し、writer を再起動すると再照合します。

警告は writer の heartbeat と一緒に共有 DB に保存します。別プロセスでも通常時は警告の有無を確認できます。heartbeat の更新が 60 秒以上確認できない場合や、古いバージョンの writer が状態を共有していない場合は、状態を確認できない旨を表示します。DB 更新が失敗してからこの時間が経つまでは、以前の状態が表示されることがあります。経過時間の判定はプロセス間の時計が大きくずれていないことを前提とします。共有が復旧すると、新しい状態が反映されます。

`index_status` には警告を先頭 25 件まで表示し、それ以外の件数を示します。長い警告も途中で省略する場合があります。writer は省略されたものを含む各警告の全文をログに書き出します。ログの場所は **writer として動作しているプロセス**の起動方法で決まります。

- MCP サーバでは `--project-dir` で指定したディレクトリ（省略時はプロセスの作業ディレクトリ）の `.search-docs/server.log` を確認します。`SEARCH_DOCS_LOG_PATH` を設定した場合はそのパスです。通常の MCP クライアントによる非 TTY 起動では標準エラーに警告は転送されません。
- Docker MCP サーバの既定はコンテナ内の `/workspace/.search-docs/server.log` です。例えば `-v "$PWD/.search-docs:/workspace/.search-docs"` でマウントした場合、ホストの `.search-docs/server.log` で確認できます。`--project-dir` や `SEARCH_DOCS_LOG_PATH` を変更した場合は、変更先と対応するマウントを確認してください。通常の非 TTY 起動では `docker logs` だけではこの警告を確認できません。
- `search-docs server start` の CLI 起動ログは、`--log` で指定したパス、未指定ならプロジェクトの `.search-docs/server.log` に出力します。writer の警告ログは起動モードで異なります。デーモンモードでは CLI と同じパスを使い、親環境の `SEARCH_DOCS_LOG_PATH` より優先されます。`--foreground` では `--log` は writer に渡されず、親環境の `SEARCH_DOCS_LOG_PATH`、未指定ならプロジェクトの `.search-docs/server.log` が使われます。たとえば `--foreground --log /tmp/custom.log` では、環境変数がなければ警告は既定の `server.log` を確認してください。直接 HTTP サーバを起動する場合も `SEARCH_DOCS_LOG_PATH`、未指定ならプロジェクトの `.search-docs/server.log` です。

標準出力が TTY の場合はコンソールにも出力されます。ログは約 1 MiB ごとに切り替わり、現行ファイルと `.1`〜`.3` を保持します。古い警告はローテーションで消えるため、必要なら早めに保存してください。ログ先が書き込み不能、容量不足、コンテナ内だけに保存してコンテナを削除した場合などは全文を取得できず、ログ出力エラーでプロセスが停止する場合もあります。ログは永続的な監査記録ではありません。

この処理は通常運用中に管理領域や途中ディレクトリが第三者に同時に差し替えられないこと、監視中の変更通知が届くことを前提とします。確認後の悪意ある同時差し替え、通知喪失、期限切れ後に旧 writer の中断処理が復帰する場合の完全な整合性は保証しません。

source ルートを変更して同じ保存先・索引を再利用した場合、以前のルートの由来は判定できず、現在の設定に基づいて照合します。設定変更後に検索結果や文書コピーに問題が生じた場合は、元ソースを残したまま search-docs の管理データを作り直してください。

## 関連ドキュメント

- [アーキテクチャ](./architecture.md)
- [データモデル](./data-model.md)
- [クライアントライブラリ](./client-library.md)
