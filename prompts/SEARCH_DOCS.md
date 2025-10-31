# search-docs 開発時利用マニュアル

このプロジェクト自体でsearch-docsを使用するためのマニュアルです。

## 概要

search-docs自身のドキュメント（README.md、docs/、AGENTS.mdなど）をインデックス化し、検索可能にします。

## セットアップ

### 設定ファイルの初期化（初回のみ）

プロジェクトで初めてsearch-docsを使用する場合は、設定ファイルを生成します：

```bash
# 基本的な使い方（ランダムポート）
node packages/cli/dist/index.js config init

# ポート番号を指定
node packages/cli/dist/index.js config init --port 12345

# 既存ファイルを上書き
node packages/cli/dist/index.js config init --force
```

**このプロジェクトでは既に設定ファイル `.search-docs.json` が配置済みです。**

### インデックス対象

- `**/*.md` - すべてのMarkdownファイル
- `docs/**/*.md` - docsディレクトリ配下のドキュメント
- `packages/**/README.md` - 各パッケージのREADME

### 除外対象

- `**/node_modules/**`
- `**/.git/**`
- `**/dist/**`
- `**/build/**`
- `**/__test*/**`

## 使い方

### 1. サーバの起動

開発環境では、ビルド済みのCLIを使用します。

```bash
# プロジェクトルートで
node packages/cli/dist/index.js server start --daemon
```

または、開発スクリプトを使用:

```bash
cd packages/cli
pnpm dev server start --daemon
```

### 2. サーバのステータス確認

```bash
node packages/cli/dist/index.js server status
```

出力例:
```
Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:  Running
PID:     12345
Port:    24280
Project: search-docs
Started: 2025-01-29T12:00:00.000Z
```

### 3. ドキュメントの検索

```bash
# 基本検索
node packages/cli/dist/index.js search "クライアント・サーバ構成"

# 深度指定
node packages/cli/dist/index.js search "Vector検索" --depth 1

# 結果数指定
node packages/cli/dist/index.js search "LanceDB" --limit 20

# JSON形式で出力
node packages/cli/dist/index.js search "埋め込みモデル" --format json
```

### 4. サーバの停止

```bash
node packages/cli/dist/index.js server stop
```

### 5. サーバの再起動

```bash
node packages/cli/dist/index.js server restart
```

## 開発中の注意事項

### ビルドが必要

CLIコマンドを使用する前に、必ずビルドが必要です:

```bash
pnpm build
```

または、特定のパッケージのみ:

```bash
pnpm --filter @search-docs/cli build
```

### サーバが起動しない場合

1. **ポート競合**
   ```bash
   # ポート24280が使用中か確認
   lsof -i :24280

   # 別のポートで起動
   node packages/cli/dist/index.js server start --daemon --port 24281
   ```

2. **古いPIDファイル**
   ```bash
   # PIDファイルを削除
   rm .search-docs/server.pid
   ```

3. **Python環境**
   ```bash
   # uvで環境を再構築
   uv sync
   ```

### ログの確認

デーモンモードで起動した場合、ログファイルを指定できます:

```bash
node packages/cli/dist/index.js server start --daemon --log .search-docs/server.log
```

ログを確認:
```bash
tail -f .search-docs/server.log
```

## トラブルシューティング

### サーバが応答しない

```bash
# サーバプロセスを強制終了
pkill -f "search-docs.*server"

# PIDファイルを削除
rm -f .search-docs/server.pid

# 再起動
node packages/cli/dist/index.js server start --daemon
```

### インデックスの再構築

現在、自動インデックス化は未実装です。将来的には以下のコマンドで再構築可能になります:

```bash
# 予定（未実装）
node packages/cli/dist/index.js index rebuild
```

### 設定ファイルの変更

`.search-docs.json` を変更した場合は、サーバを再起動してください:

```bash
node packages/cli/dist/index.js server restart
```

## Claude Code統合（将来実装予定）

MCP Serverとして統合することで、Claude Codeから直接検索可能になります:

```bash
# 予定（未実装）
claude mcp add search-docs -- \
  node /path/to/search-docs/packages/mcp-server/dist/index.js \
  --project $(pwd)
```

## 参考

- **プロジェクト概要**: @AGENTS.md
- **アーキテクチャ**: @docs/client-server-architecture.md
- **データモデル**: @docs/data-model.md
- **システムアーキテクチャ**: @docs/architecture.md
