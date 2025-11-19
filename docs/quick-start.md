# 🐕️ クイックスタートガイド

5分でsearch-docsを試してみましょう！

## ゴール

このガイドでは以下を実施します：

1. ✅ search-docsをセットアップ
2. ✅ サンプル文書を用意
3. ✅ サーバを起動
4. ✅ 文書を検索
5. ✅ インデックス状態を確認

## 前提条件

- Node.js (v18以上)
- pnpm（開発環境の場合）

## ステップ1: セットアップ

### 開発環境の場合

```bash
# リポジトリをクローン
git clone <repository-url>
cd search-docs

# 依存関係のインストール
pnpm install

# Python環境のセットアップ
uv sync

# ビルド
pnpm build
```

### グローバルインストールの場合

```bash
npm install -g @search-docs/cli
```

### npxで直接実行する場合（インストール不要）

```bash
# インストール不要で直接使用可能
npx @search-docs/cli config init
npx @search-docs/cli server start
```

## ステップ2: テストプロジェクトを作成

```bash
# テストディレクトリを作成
mkdir ~/search-docs-test
cd ~/search-docs-test

# サンプル文書を作成
mkdir docs
```

`docs/README.md` を作成：

```markdown
# サンプルプロジェクト

このプロジェクトはsearch-docsのテストです。

## Vector検索とは

Vector検索は、文書をベクトル空間に埋め込み、
意味的な類似性に基づいて検索する技術です。

## LanceDBについて

LanceDBは高速なVector databaseです。
ローカル環境で動作し、大規模なデータも扱えます。

### 特徴

- 高速な検索
- ローカル実行
- スケーラブル
```

`docs/guide.md` を作成：

```markdown
# 使い方ガイド

## 基本的な使い方

search-docsは以下の手順で使用します：

1. サーバを起動
2. 文書を検索
3. 結果を確認

## 検索のコツ

具体的なキーワードを使用すると、
より精度の高い結果が得られます。
```

## ステップ3: 設定ファイルを作成

`.search-docs.json` を作成：

```json
{
  "version": "1.0",
  "project": {
    "name": "test-project",
    "root": "."
  },
  "files": {
    "include": ["**/*.md"],
    "exclude": ["**/node_modules/**"],
    "ignoreGitignore": true
  },
  "indexing": {
    "maxTokensPerSection": 2000,
    "maxDepth": 3
  }
}
```

## ステップ4: サーバを起動

### 開発環境の場合

```bash
node /path/to/search-docs/packages/cli/dist/index.js server start
```

### グローバルインストールまたはnpxの場合

```bash
# グローバルインストールした場合
search-docs server start

# npxで実行する場合
npx @search-docs/cli server start
```

**注意**: v1.0.1以降、サーバはデフォルトでバックグラウンドで起動します。

### 起動確認

```bash
# 開発環境
node /path/to/search-docs/packages/cli/dist/index.js server status

# グローバルインストール
search-docs server status
```

出力例：
```
Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:  Running
PID:     12345
Port:    24280
Project: test-project
Started: 2025-01-30T12:00:00.000Z
```

## ステップ5: インデックスを作成

```bash
# 開発環境
node /path/to/search-docs/packages/cli/dist/index.js index rebuild

# グローバルインストール
search-docs index rebuild
```

出力例：
```
Rebuilding index...
Target: All documents
Mode: Smart rebuild (skip unchanged files)

✓ Index rebuild completed
  Documents processed: 2
  Sections created: 8
```

## ステップ6: 文書を検索

### 基本的な検索

```bash
# 開発環境
node /path/to/search-docs/packages/cli/dist/index.js search "Vector検索"

# グローバルインストール
search-docs search "Vector検索"
```

出力例：
```
検索結果: 3件
処理時間: 45ms

1. docs/README.md
   見出し: Vector検索とは
   深度: 2
   スコア: 0.95
   状態: Clean

   Vector検索は、文書をベクトル空間に埋め込み、
   意味的な類似性に基づいて検索する技術です。

2. docs/README.md
   見出し: LanceDBについて
   深度: 2
   スコア: 0.82
   状態: Clean

   LanceDBは高速なVector databaseです。
   ローカル環境で動作し、大規模なデータも扱えます。

...
```

### depth指定で検索

```bash
# depth 2のみ検索
search-docs search "検索" --depth 2
```

### JSON形式で検索

```bash
search-docs search "LanceDB" --format json
```

## ステップ7: インデックス状態を確認

```bash
# 開発環境
node /path/to/search-docs/packages/cli/dist/index.js index status

# グローバルインストール
search-docs index status
```

出力例：
```
Index Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Server:
  Version:    0.1.0
  Uptime:     5m 23s
  PID:        12345

Index:
  Documents:  2
  Sections:   8
  Dirty:      0

Worker:
  Running:    Yes
  Processing: 0
  Queue:      0
```

## ステップ8: ファイル変更の自動反映を試す

1. `docs/README.md`を編集して保存

2. 少し待つ（デフォルト5秒間隔でIndexWorkerが処理）

3. 再度検索してみる

```bash
search-docs search "追加したキーワード"
```

## ステップ9: サーバを停止

```bash
# 開発環境
node /path/to/search-docs/packages/cli/dist/index.js server stop

# グローバルインストール
search-docs server stop
```

## 次のステップ

おめでとうございます！🎉 基本的な使い方をマスターしました。

さらに詳しく学ぶには：

- **[ユーザーガイド](./user-guide.md)** - 全機能の詳細な説明
- **[CLIリファレンス](./cli-reference.md)** - 全コマンドの詳細
- **[MCP統合ガイド](./mcp-integration.md)** - Claude Codeとの統合
- **[設定ファイルリファレンス](./user-guide.md#設定ファイル)** - 詳細な設定方法

## トラブルシューティング

### サーバが起動しない

```bash
# ポート競合を確認
lsof -i :24280

# 別のポートで起動
search-docs server start --port 24281
```

### 検索結果が0件

```bash
# インデックス状態を確認
search-docs index status

# 再インデックス
search-docs index rebuild --force
```

### ログを確認したい

```bash
# ログファイルを指定して起動
search-docs server start --log search-docs.log

# ログを確認
tail -f search-docs.log
```

## クリーンアップ

テストが終わったら、以下でクリーンアップできます：

```bash
# サーバを停止
search-docs server stop

# テストディレクトリを削除
cd ~
rm -rf search-docs-test
```

## 実際のプロジェクトで使う

実際のプロジェクトで使用する場合：

1. プロジェクトルートに移動
2. `.search-docs.json`を作成（上記の例を参考）
3. `files.include`と`files.exclude`を調整
4. サーバを起動

```bash
cd /path/to/your/project
# .search-docs.jsonを作成・編集
search-docs server start
search-docs index rebuild
```

これで、プロジェクトの文書を検索できるようになります！
