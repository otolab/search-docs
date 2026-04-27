# Claude Code 統合ガイド（MCP）

search-docsをClaude Codeから使う際の、MCPツールリファレンスです。

## 始め方

### Docker版（推奨）

**ランタイム依存（Node.js, Python, uv）を排除し、セキュアな境界で実行**できます。

```bash
docker run --rm -i \
  -v .:/workspace:ro \
  -v ./.search-docs:/workspace/.search-docs \
  otolab/search-docs-mcp:latest
```

**注**: Docker MCP カタログに登録完了後は `docker mcp run search-docs` でも利用可能になります。

→ [Docker構成ガイド](./docker-deployment.md)

### npm/npx版（Docker環境がない場合）

Docker環境がない場合の代替手段です。

```bash
claude mcp add npx -- -y @search-docs/mcp-server
```

詳細: **[クイックスタート - Claude Code](./quick-start.md#方法1-claude-codeで試す30秒)**

---

## MCPツールリファレンス

このドキュメントでは、MCPから利用できるツールの詳細を説明します。

---

## 利用可能なツール

search-docsのMCP Serverは以下のツールを提供します。

### 1. `search` - 文書検索

自然言語のクエリで文書を検索します。

**パラメータ**:

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|-----------|------|
| `query` | string | ✓ | - | 検索クエリ（自然言語） |
| `limit` | number | - | 10 | 最大結果数 |
| `previewLines` | number | - | 5 | プレビュー行数 |
| `depth` | number \| number[] | - | - | 検索深度フィルタ（0-3）<br>例: `2` または `[1, 2]` |
| `includeCleanOnly` | boolean | - | false | Clean（最新）なSectionのみ検索 |
| `includePaths` | string[] | - | - | 含めるパス（前方一致）<br>例: `["docs/", "README.md"]` |
| `excludePaths` | string[] | - | - | 除外するパス（前方一致）<br>例: `["docs/internal/"]` |

**使用例**:

```
ユーザー: Vector検索の実装について教えて

Claude: [searchツールを使用]
        query: "Vector検索 実装"
        limit: 5
        depth: [1, 2]
```

**レスポンス例**:

```
検索結果: 3件

1. docs/architecture.md (行42-68)
   セクション: 1.2.1 Vector検索エンジン
   深度: 2, スコア: 0.95

   Vector検索は、LanceDBとRuri Embeddingを使用して実装されています。
   日本語に最適化された埋め込みモデルにより、高精度な検索が可能です。
   ...
```

**depth パラメータの使い方**:

- `depth: 0` - 文書全体のみ検索
- `depth: 2` - H2見出し単位のみ検索
- `depth: [1, 2]` - H1とH2見出し単位を検索（配列で複数指定）

---

### 2. `get_document` - 文書取得

特定の文書またはセクションの内容を取得します。

**パラメータ**:

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `path` | string | - | 文書パス<br>例: `"docs/architecture.md"` |
| `sectionId` | string | - | セクションID（検索結果から取得）|

**注意**: `path` と `sectionId` のどちらか一方は必須

**使用例1: パス指定**:

```
ユーザー: architecture.mdの内容を見せて

Claude: [get_documentツールを使用]
        path: "docs/architecture.md"
```

**使用例2: セクションID指定**:

```
Claude: [searchツールで取得したsectionIdを使用]
        sectionId: "section-uuid-12345"
```

**レスポンス例**:

```
文書: docs/architecture.md
セクション: Vector検索エンジン
深度: 2

# Vector検索エンジン

LanceDBとRuri Embeddingを使用したVector検索エンジンです。

## 主要技術スタック

- LanceDB: Vector database
- Ruri Embedding: 日本語最適化モデル
...
```

---

### 3. `get_outline` - 文書のアウトライン取得

文書の構造（目次）を取得します。長い文書の全体像を把握するのに便利です。

**パラメータ**:

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `path` | string | - | 文書パス |
| `sectionId` | string | - | セクションID（そのセクション配下のアウトライン）|

**注意**: `path` と `sectionId` のどちらか一方は必須

**使用例**:

```
ユーザー: user-guide.mdの構成を教えて

Claude: [get_outlineツールを使用]
        path: "docs/user-guide.md"
```

**レスポンス例**:

```
文書: docs/user-guide.md
総セクション数: 24

アウトライン:

0. user-guide.md (depth 0)
   行: 1-594, トークン: 2150, Section ID: abc123

1. 基本的な概念 (depth 1)
   行: 17-99, トークン: 450, Section ID: def456

  1.1 Document（文書） (depth 2)
      行: 21-27, トークン: 80, Section ID: ghi789

  1.2 Section（セクション） (depth 2)
      行: 29-53, トークン: 180, Section ID: jkl012

  1.3 Dirty管理 (depth 2)
      行: 55-60, トークン: 90, Section ID: mno345

2. 始め方 (depth 1)
   行: 102-121, トークン: 120, Section ID: pqr678
   ...
```

**活用方法**:

1. **文書の全体像を把握**: 長い文書を読む前に構造を確認
2. **目的のセクションを特定**: アウトラインからSection IDを取得
3. **特定セクションを取得**: Section IDで`get_document`を実行

**実践例**:

```
ユーザー: user-guide.mdのDirty管理について詳しく教えて

Claude: まず文書の構造を確認します。
        [get_outlineツールを使用: path="docs/user-guide.md"]

        アウトラインから、「1.3 Dirty管理」のセクションを見つけました。
        Section ID: mno345

        では詳細を取得します。
        [get_documentツールを使用: sectionId="mno345"]

        Dirty管理について説明します：

        Dirtyは、インデックスが最新でないSectionの状態です。
        ...
```

---

### 4. `index_status` - インデックス状態確認

インデックスの統計情報を取得します。

**パラメータ**: なし

**使用例**:

```
ユーザー: インデックスの状態を確認して

Claude: [index_statusツールを使用]
```

**レスポンス例**:

```
インデックス状態
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

サーバ情報:
  バージョン: 1.0.0
  稼働時間: 2h 15m 30s
  PID: 12345

インデックス統計:
  総文書数: 152
  総セクション数: 1,018
  Dirty: 0

ワーカー状態:
  実行中: はい
  処理中: 0
  キュー: 0
```

---

## 実践的な使用例

### 例1: 特定トピックの調査

```
ユーザー: LanceDBのインデックス戦略について調べて

Claude: LanceDBのインデックス戦略について検索します。

[searchツール: query="LanceDB インデックス戦略", limit=5]

検索結果から以下が見つかりました：

1. docs/architecture-decisions.md - ADR-016: LanceDBインデックス戦略

   カーディナリティベースのインデックスタイプ選択について説明されています。
   詳細を確認しますか？

ユーザー: はい

Claude: [get_documentツール: 検索結果のsectionIdを使用]

詳細は以下です：

# ADR-016: LanceDBインデックス戦略

## 決定内容

カーディナリティに基づいてインデックスタイプを選択：
- 低カーディナリティ: BTREE (document_path, document_hash)
- 高カーディナリティ: BITMAP (status, is_dirty)
...
```

### 例2: 長い文書の効率的な探索

```
ユーザー: user-guide.mdから設定ファイルの説明を探して

Claude: user-guide.mdの構造を確認します。

[get_outlineツール: path="docs/user-guide.md"]

アウトラインから「設定ファイル」セクションを発見しました（Section ID: xyz789）

[get_documentツール: sectionId="xyz789"]

設定ファイルの詳細は以下です：
...
```

### 例3: 関連情報の横断検索

```
ユーザー: Dirty管理に関する全ての情報をまとめて

Claude: Dirty管理に関する文書を検索します。

[searchツール: query="Dirty管理", limit=10]

複数の文書で言及されています：

1. user-guide.md - 基本的な概念 > Dirty管理
2. architecture.md - IndexWorker > Dirty処理
3. data-model.md - Section状態管理

それぞれの詳細を確認して統合しますね。

[get_documentツール × 3回: 各sectionIdで取得]

Dirty管理について、3つの観点からまとめます：
...
```

---

## トラブルシューティング

### 検索結果が0件

**原因**:
- インデックスがまだ作成されていない
- クエリが適切でない

**確認方法**:

```
ユーザー: インデックスの状態を確認して

Claude: [index_statusツール]
        総セクション数: 0  ← インデックスが空
```

**解決**: サーバが起動してインデックス生成が完了するまで待つ（通常数秒〜数分）

### 文書が見つからない

**原因**:
- パスが間違っている
- ファイルが設定で除外されている

**確認方法**:

```
ユーザー: プロジェクトにどんな文書があるか検索して

Claude: [searchツール: query="", limit=50]
        ← 空クエリで全文書を確認
```

---

## 関連ドキュメント

- **[クイックスタート](./quick-start.md)** - セットアップ方法
- **[ユーザーガイド](./user-guide.md)** - 基本的な概念
- **[CLIリファレンス](./cli-reference.md)** - コマンドライン操作
