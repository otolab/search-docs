# CLI コマンドリファレンス

search-docs CLIツールの完全なコマンドリファレンスです。

## 目次

- [グローバルオプション](#グローバルオプション)
- [server コマンド](#server-コマンド)
- [search コマンド](#search-コマンド)
- [index コマンド](#index-コマンド)
- [config コマンド](#config-コマンド)
- [終了コード](#終了コード)

## グローバルオプション

すべてのコマンドで使用可能なオプションです。

```bash
search-docs [options] [command]
```

### オプション

| オプション | 説明 |
|-----------|------|
| `-V, --version` | バージョン番号を表示 |
| `-h, --help` | ヘルプを表示 |

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
| `--config <path>` | 設定ファイルのパス | `.search-docs.json` |
| `--port <port>` | ポート番号 | `24280` |
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

# カスタム設定ファイルを使用
search-docs server start --config ./custom-config.json
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
search-docs server stop [options]
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--config <path>` | 設定ファイルのパス | `.search-docs.json` |

#### 使用例

```bash
# サーバを停止
search-docs server stop

# カスタム設定ファイルを指定
search-docs server stop --config ./custom-config.json
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
search-docs server status [options]
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--config <path>` | 設定ファイルのパス | `.search-docs.json` |

#### 使用例

```bash
# サーバの状態を確認
search-docs server status
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
| `--config <path>` | 設定ファイルのパス | `.search-docs.json` |

#### 使用例

```bash
# サーバを再起動
search-docs server restart
```

#### 動作

1. サーバを停止（`server stop`）
2. 1秒待機
3. サーバを起動（`server start`）

#### 注意事項

- 常にバックグラウンドモードで起動されます
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
| `--depth <depths...>` | 深度フィルタ（複数指定可） | すべて |
| `--format <format>` | 出力形式（text, json） | `text` |
| `--clean-only` | Dirtyセクションを除外 | `false` |
| `--server <url>` | サーバURL | `http://localhost:24280` |

### 使用例

```bash
# 基本的な検索
search-docs search "Vector検索"

# 結果数を指定
search-docs search "Vector検索" --limit 20

# depth 1と2のみ検索
search-docs search "Vector検索" --depth 1 2

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

## config コマンド

設定ファイルの管理を行います。

### config init

設定ファイルを初期化します（**未実装**）。

```bash
search-docs config init [options]
```

#### オプション

| オプション | 説明 |
|-----------|------|
| `--interactive, -i` | 対話的に設定を作成 |
| `--force, -f` | 既存ファイルを上書き |

#### 注意

このコマンドは将来実装予定です。現在は手動で`.search-docs.json`を作成してください。

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
