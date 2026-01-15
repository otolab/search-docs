# 🐕️ クイックスタートガイド

search-docsを試してみましょう！

## 2つの始め方

### 🚀 Claude Codeで試す（推奨・30秒）

Claude Codeをお使いの場合、最も簡単に始められます。

### 💻 CLIツールで試す（5分）

コマンドラインから直接使いたい場合。

---

## 🚀 方法1: Claude Codeで試す（30秒）

### ステップ1: MCPサーバを追加

```bash
claude mcp add npx -- -y @search-docs/mcp-server
```

### ステップ2: Claude Codeで依頼

1. **「search-docsのセットアップをお願い」**と依頼
   - エージェントが設定ファイルを作成してくれます
   - 設定内容について相談できます

2. **MCPを再接続（reconnect）**
   - Claude Codeを再起動するか、MCPを再接続

3. **「サーバを起動してください」**と依頼
   - エージェントがサーバを起動してくれます

4. **インデックス生成を待つ**
   - バックグラウンドで文書をインデックス化（数秒〜数分）

5. **「このプロジェクトのアーキテクチャについて教えて」**と依頼
   - エージェントが文書を検索して回答してくれます

### 完了！

これで、Claude Codeからプロジェクトの文書を検索できるようになりました。

**次のステップ**: [Claude Code統合ガイド](./mcp-integration.md)で詳しい使い方を確認

---

## 💻 方法2: CLIツールで試す（5分）

### ゴール

- サンプルプロジェクトを作成
- サーバを起動
- 文書を検索

### ステップ1: テストプロジェクトを作成

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

### ステップ2: 設定ファイルを作成

```bash
# npxで設定ファイルを初期化
npx @search-docs/cli config init
```

または手動で `.search-docs.json` を作成：

```json
{
  "version": "1.0",
  "files": {
    "include": ["**/*.md"],
    "exclude": ["**/node_modules/**"]
  }
}
```

### ステップ3: サーバを起動

```bash
# npxで実行（インストール不要）
npx @search-docs/cli server start
```

出力例：
```
✓ Server started successfully
  PID:     12345
  Port:    50123
  Project: search-docs-test
```

### ステップ4: 文書を検索

```bash
# 基本的な検索
npx @search-docs/cli search "Vector検索"
```

出力例：
```
検索結果: 3件
処理時間: 45ms

1. docs/README.md
   見出し: Vector検索とは
   深度: 2
   スコア: 0.95

   Vector検索は、文書をベクトル空間に埋め込み、
   意味的な類似性に基づいて検索する技術です。

2. docs/README.md
   見出し: LanceDBについて
   深度: 2
   スコア: 0.82

   LanceDBは高速なVector databaseです。
   ローカル環境で動作し、大規模なデータも扱えます。
...
```

### ステップ5: サーバを停止

```bash
npx @search-docs/cli server stop
```

### 完了！

基本的な使い方をマスターしました。

**次のステップ**: [ユーザーガイド](./user-guide.md)で本格的に使う方法を確認

---

## クリーンアップ

テストが終わったら：

```bash
# サーバを停止
npx @search-docs/cli server stop

# テストディレクトリを削除
cd ~
rm -rf search-docs-test
```

---

## 次のステップ

### 本格的に使う

- **[ユーザーガイド](./user-guide.md)** - 実際のプロジェクトでの使い方
- **[CLIリファレンス](./cli-reference.md)** - 全コマンドの詳細

### 詳しく知る

- **[システムアーキテクチャ](./architecture.md)** - 仕組みを理解する
- **[データモデル](./data-model.md)** - Document, Section, Indexの詳細

### 統合する

- **[Claude Code統合](./mcp-integration.md)** - エージェントと使う
- **[クライアントライブラリ](./client-library.md)** - プログラムから使う

---

## トラブルシューティング

### サーバが起動しない

```bash
# ポート競合を確認
lsof -i :24280

# 別のポートで起動
npx @search-docs/cli server start --port 24281
```

### 検索結果が0件

```bash
# インデックス状態を確認
npx @search-docs/cli index status

# 再インデックス
npx @search-docs/cli index rebuild
```

詳細: [ユーザーガイド - トラブルシューティング](./user-guide.md#トラブルシューティング)
