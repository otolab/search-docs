# CLI コマンドリファレンス

search-docs CLIツールの完全なコマンドリファレンスです。

## インストールと使用方法

### グローバルインストール

```bash
npm install -g @search-docs/cli
```

### npxで直接実行（インストール不要）

```bash
npx @search-docs/cli <command>
```

**注意**: 以下のコマンド例では `search-docs` を使用していますが、npxで実行する場合は `npx @search-docs/cli` に置き換えてください。

## 目次

- [グローバルオプション](#グローバルオプション)
- [server コマンド](#server-コマンド)
- [search コマンド](#search-コマンド)
- [index コマンド](#index-コマンド)
- [embedding コマンド](#embedding-コマンド)
- [config コマンド](#config-コマンド)
- [終了コード](#終了コード)

## グローバルオプション

すべてのコマンドで使用可能なオプションです。

```bash
search-docs [options] [command]
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-v, --version` | バージョン情報を表示 | - |
| `-c, --config <path>` | 設定ファイルのパス | `.search-docs.json` |
| `-h, --help` | ヘルプを表示 | - |

**注意**: `--config`オプションはグローバルオプションのため、コマンドの前に指定します。

```bash
# 正しい使い方
search-docs --config ./custom-config.json server start

# 誤った使い方
search-docs server start --config ./custom-config.json
```

### 使用例

```bash
# バージョン確認
search-docs --version

# ヘルプ表示
search-docs --help

# 特定のコマンドのヘルプ
search-docs server --help
```

## server コマンド

サーバの起動、停止、状態確認を行います。

### server start

サーバを起動します。

```bash
search-docs server start [options]
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--port <port>` | ポート番号 | 設定ファイルのポート |
| `--foreground, -f` | フォアグラウンドで起動（開発時） | `false` |
| `--log <path>` | ログファイルのパス | なし |

#### 使用例

```bash
# バックグラウンドで起動（デフォルト）
search-docs server start

# フォアグラウンドで起動（開発時）
search-docs server start --foreground

# カスタムポートで起動
search-docs server start --port 24281

# ログファイルを指定して起動
search-docs server start --log .search-docs/server.log

# カスタム設定ファイルを使用（グローバルオプション）
search-docs --config ./custom-config.json server start
```

#### 動作

1. 設定ファイルを読み込む
2. DocumentStorageを初期化
3. DBEngineを起動（Python worker）
4. ファイルウォッチャーを起動
5. IndexWorkerを起動
6. JSON-RPCサーバを起動
7. PIDファイルを作成（バックグラウンドモード時）

#### 注意事項

- すでにサーバが起動している場合はエラーになります
- デフォルトでバックグラウンド起動します（v1.0.1以降）
- フォアグラウンドモードは開発時に便利です

### server stop

サーバを停止します。

```bash
search-docs server stop
```

#### オプション

なし（グローバルオプション`--config`は使用可能）

#### 使用例

```bash
# サーバを停止
search-docs server stop

# カスタム設定ファイルを指定（グローバルオプション）
search-docs --config ./custom-config.json server stop
```

#### 動作

1. PIDファイルからプロセスIDを取得
2. プロセスにSIGTERMシグナルを送信
3. プロセスの終了を待機（最大10秒）
4. PIDファイルを削除

#### 注意事項

- サーバが起動していない場合はエラーになります
- 強制終了が必要な場合は`kill -9 <PID>`を使用してください

### server status

サーバの状態を確認します。

```bash
search-docs server status
```

#### オプション

なし（グローバルオプション`--config`は使用可能）

#### 使用例

```bash
# サーバの状態を確認
search-docs server status

# カスタム設定ファイルを指定（グローバルオプション）
search-docs --config ./custom-config.json server status
```

#### 出力例

```
Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:  Running
PID:     12345
Port:    24280
Project: my-project
Started: 2025-01-30T12:00:00.000Z
```

#### 表示項目

- **Status**: `Running` または `Not running`
- **PID**: プロセスID
- **Port**: 待ち受けポート番号
- **Project**: プロジェクト名
- **Started**: 起動日時

### server restart

サーバを再起動します。

```bash
search-docs server restart [options]
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--port <port>` | ポート番号 | 設定ファイルのポート |
| `--foreground, -f` | フォアグラウンドで起動（開発時） | `false` |
| `--log <path>` | ログファイルのパス | なし |

#### 使用例

```bash
# サーバを再起動（バックグラウンド）
search-docs server restart

# フォアグラウンドで再起動
search-docs server restart --foreground

# カスタムポートで再起動
search-docs server restart --port 24281
```

#### 動作

1. サーバを停止（`server stop`）
2. 1秒待機
3. サーバを起動（`server start`）

#### 注意事項

- 設定ファイルを変更した場合は再起動が必要です

## search コマンド

文書を検索します。

```bash
search-docs search <query> [options]
```

### 引数

| 引数 | 必須 | 説明 |
|-----|------|------|
| `<query>` | ✓ | 検索クエリ |

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--limit <n>` | 最大結果数 | `10` |
| `--depth <depth>` | 最大深度（0=文書全体のみ、1=章まで、2=節まで、3=項まで） | すべて |
| `--format <format>` | 出力形式（text, json） | `text` |
| `--clean-only` | Dirtyセクションを除外 | `false` |
| `--server <url>` | サーバURL | 設定ファイルのURL |

### 使用例

```bash
# 基本的な検索
search-docs search "Vector検索"

# 結果数を指定
search-docs search "Vector検索" --limit 20

# depth 1まで検索（文書全体と章）
search-docs search "Vector検索" --depth 1

# depth 2まで検索（文書全体、章、節）
search-docs search "Vector検索" --depth 2

# JSON形式で出力
search-docs search "Vector検索" --format json

# Cleanなセクションのみ検索
search-docs search "Vector検索" --clean-only

# 別のサーバに接続
search-docs search "Vector検索" --server http://localhost:24281
```

### 出力形式

#### テキスト形式（デフォルト）

```
検索結果: 42件
処理時間: 123ms

1. docs/README.md
   見出し: 概要
   深度: 1
   スコア: 0.95
   状態: Clean

   ローカル文書検索システム - Markdown文書に対する
   Vector検索機能を提供します...

2. docs/architecture.md
   ...
```

#### JSON形式

```json
{
  "results": [
    {
      "id": "...",
      "documentPath": "docs/README.md",
      "documentHash": "abc123...",
      "heading": "概要",
      "depth": 1,
      "content": "...",
      "score": 0.95,
      "isDirty": false,
      "tokenCount": 150,
      "startLine": 42,
      "endLine": 68,
      "sectionNumber": [1, 2, 1]
    }
  ],
  "total": 42,
  "took": 123
}
```

**フィールド説明**:
- `documentPath`: 文書のパス
- `heading`: セクションの見出し
- `depth`: セクションの深度（0-3）
- `content`: セクションの本文
- `score`: 検索スコア（0-1、高いほど関連性が高い）
- `isDirty`: セクションが最新でない場合 `true`
- `startLine`: セクションの開始行番号 (v1.0.4以降)
- `endLine`: セクションの終了行番号 (v1.0.4以降)
- `sectionNumber`: セクション番号の配列 (v1.0.4以降、例: `[1, 2, 1]` は「第1章 > 第2節 > 第1項」)

### depthについて

depthは文書の分割階層を表します：

- **depth 0**: 文書全体
- **depth 1**: 第1レベルの見出し（# 見出し）
- **depth 2**: 第2レベルの見出し（## 見出し）
- **depth 3**: 第3レベルの見出し（### 見出し）

より深いdepthほど詳細な情報が得られます。

## index コマンド

インデックスの管理を行います。

### index rebuild

インデックスを再構築します。

```bash
search-docs index rebuild [paths...] [options]
```

#### 引数

| 引数 | 必須 | 説明 |
|-----|------|------|
| `[paths...]` | - | 再構築するファイルパス（省略時は全文書） |

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--force` | 強制的に再インデックス（ハッシュチェック無視） | `false` |
| `--server <url>` | サーバURL | `http://localhost:24280` |

#### 使用例

```bash
# 全文書を再構築
search-docs index rebuild

# 特定のファイルのみ再構築
search-docs index rebuild docs/README.md AGENTS.md

# 強制的に全て再インデックス
search-docs index rebuild --force

# 特定のファイルを強制再インデックス
search-docs index rebuild docs/README.md --force
```

#### 動作

1. 指定されたファイル（または全文書）を取得
2. 各ファイルについて：
   - ファイル内容を読み込む
   - ハッシュを計算
   - 既存のハッシュと比較（`--force`時はスキップ）
   - 変更がある場合、または`--force`の場合：
     - 既存セクションを削除
     - Markdownを解析
     - セクションに分割
     - ベクトル化
     - インデックスに保存
3. 処理結果を表示

#### 出力例

```
Rebuilding index...
Target: All documents
Mode: Smart rebuild (skip unchanged files)

✓ Index rebuild completed
  Documents processed: 152
  Sections created: 1018
```

#### 注意事項

- `--force`を使用すると全てのセクションが再作成されるため時間がかかります
- 大量の文書がある場合、初回のインデックス作成には時間がかかります

### index status

インデックスの状態を確認します。

```bash
search-docs index status [options]
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--server <url>` | サーバURL | `http://localhost:24280` |
| `--format <format>` | 出力形式（text, json） | `text` |

#### 使用例

```bash
# インデックスの状態を確認
search-docs index status

# JSON形式で出力
search-docs index status --format json
```

#### 出力例（テキスト形式）

```
Index Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Server:
  Version:    0.1.0
  Uptime:     1h 51m 33s
  PID:        80204

Index:
  Documents:  152
  Sections:   1018
  Dirty:      0

Worker:
  Running:    Yes
  Processing: 0
  Queue:      0
```

#### 表示項目

**Server**:
- Version: サーバのバージョン
- Uptime: 稼働時間
- PID: プロセスID

**Index**:
- Documents: インデックス化された文書数
- Sections: セクション数
- Dirty: Dirty状態のセクション数

**Worker**:
- Running: ワーカーが実行中か
- Processing: 現在処理中のタスク数
- Queue: キューに残っているタスク数

## embedding コマンド

Embeddingサーバの起動・停止・状態確認を行います。

Embeddingサーバはプロジェクト横断で共有利用できるため、PIDとログは `~/.search-docs/` に配置されます（プロジェクトごとの `.search-docs/` ではありません）。ホスト側でGPU/CoreMLアクセラレーションを利用したい場合や、複数プロジェクトでEmbeddingモデルを共有したい場合に便利です。

### embedding start

Embeddingサーバをデーモン起動します。

```bash
search-docs embedding start [options]
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--port <port>` | ポート番号 | `24281` |
| `-f, --foreground` | フォアグラウンドで起動（開発時） | `false` |
| `--runtime <runtime>` | ランタイム（`onnx` または `torch`） | `onnx` |
| `--dimension <dim>` | ベクトル次元数 | `256` |

#### 使用例

```bash
# バックグラウンドで起動（デフォルト）
search-docs embedding start

# フォアグラウンドで起動（開発時）
search-docs embedding start --foreground

# カスタムポートで起動
search-docs embedding start --port 24282

# torchランタイムで起動
search-docs embedding start --runtime torch
```

#### 動作

1. 既存サーバがないことを確認
2. ポートの空き状況を確認
3. `uv --project <db-engine> run python embedding_server.py` で起動
4. `/health` エンドポイントでReadiness待ち（初回はモデルダウンロードで時間がかかる場合があります）
5. PIDファイル（`~/.search-docs/embedding.pid`）を保存

#### アクセラレータ自動検出

ONNX Runtimeのアクセラレータを自動検出します：

- **Apple Silicon**: CoreMLExecutionProvider（445/724ノード対応）
- **NVIDIA GPU**: CUDAExecutionProvider
- **それ以外**: CPUExecutionProvider

#### モデルパス自動解決

以下の優先順で探します：

1. Docker内蔵パス（`/app/.cache/models/ruri-v3-30m-onnx`）
2. プロジェクトキャッシュ（`cwd/.cache/models/ruri-v3-30m-onnx`）
3. HuggingFace Hubから自動ダウンロード（`sirasagi62/ruri-v3-30m-ONNX`）

#### 注意事項

- すでにサーバが起動している場合は何もしません
- 初回起動時はモデルのダウンロードに時間がかかります
- ログは `~/.search-docs/embedding.log` に出力されます

### embedding stop

Embeddingサーバを停止します。

```bash
search-docs embedding stop
```

#### オプション

なし

#### 使用例

```bash
# サーバを停止
search-docs embedding stop
```

#### 動作

1. PIDファイル（`~/.search-docs/embedding.pid`）からプロセスIDを取得
2. プロセスにSIGTERMシグナルを送信
3. プロセスの終了を待機
4. PIDファイルを削除

#### 注意事項

- サーバが起動していない場合はエラーになります

### embedding status

Embeddingサーバの状態を確認します。

```bash
search-docs embedding status
```

#### オプション

なし

#### 使用例

```bash
# サーバの状態を確認
search-docs embedding status
```

#### 出力例

```
Embedding Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:     Running
PID:        45678
Port:       24281
Model:      cl-nagoya/ruri-v3-30m
Dimension:  256
Started:    2026-04-21T10:30:00.000Z
Log:        /Users/username/.search-docs/embedding.log
```

#### 表示項目

- **Status**: `Running` または `Not running`
- **PID**: プロセスID
- **Port**: 待ち受けポート番号
- **Model**: モデル名
- **Dimension**: ベクトル次元数
- **Started**: 起動日時
- **Log**: ログファイルのパス

### Docker MCPサーバからの利用

Docker内のMCPサーバは、`host.docker.internal:24281` 経由でホスト側のEmbeddingサーバを自動検出します。ホスト側でEmbeddingサーバを起動しておくだけで、Docker MCPサーバが自動的に接続します。

```bash
# ホスト側でEmbeddingサーバを起動
search-docs embedding start

# Docker MCPサーバを起動（自動的にホスト側のEmbeddingサーバを検出）
docker run --rm -i \
  -v .:/workspace:ro \
  -v ./.search-docs:/workspace/.search-docs \
  otolab/search-docs-mcp:latest
```

**注**: Docker MCP カタログに登録完了後は `docker mcp run search-docs` でも利用可能になります。

詳細は [Docker構成](./docker-deployment.md) を参照してください。

## config コマンド

設定ファイルの管理を行います。

### config init

設定ファイルを初期化します。生成先は `.search-docs/config.json` です。

```bash
search-docs config init [options]
```

#### オプション

| オプション | 説明 |
|-----------|------|
| `--port <port>` | サーバポート番号（省略時はランダム） |
| `--project-root <path>` | プロジェクトルート（デフォルト: カレントディレクトリ） |
| `--force, -f` | 既存ファイルを上書き |

#### 動作

- 既存の設定ファイル（`.search-docs/config.json`、`.search-docs.json`、`search-docs.json`）がある場合、`--force` を指定しなければ既存設定を変更せず、情報メッセージを表示して終了します。
- `--force` を指定した場合は、生成先の `.search-docs/config.json` を上書きします。

## 終了コード

CLIコマンドは以下の終了コードを返します：

| コード | 意味 |
|-------|------|
| `0` | 成功 |
| `1` | エラー（一般的なエラー） |
| `2` | 使用方法のエラー（無効な引数など） |

## 環境変数

現在、環境変数による設定はサポートされていません。すべての設定は設定ファイルまたはコマンドライン引数で指定してください。

## 関連ドキュメント

- [ユーザーガイド](./user-guide.md) - 基本的な使い方
- [クイックスタート](./quick-start.md) - 5分で試す
- [MCP統合ガイド](./mcp-integration.md) - Claude Code統合
