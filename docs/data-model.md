# データモデル設計

## 要件まとめ

### 1. 文書の入力と保存

#### 入力
- **単位**: 一つの文書（複数回の入力が行われる）
- **保存形式**: 文書全体を完全な状態で保存
- **文書Key**: パス形式（プロジェクトドキュメントへのパスと一対一対応）

#### バージョン管理
- **方式**: バージョン管理なしの全体保存を採用（v1）
- **操作**: 更新、削除が可能
- **ストレージインターフェイス**: 明確に分離（将来的なバージョン管理対応の余地）

### 2. データレイヤーの分離

#### ストレージレイヤー（DocumentStorage）
- **責務**: 文書データの永続化
- **操作**: CRUD操作
- **形式**: 文書全体の保存・取得

#### 検索レイヤー（SearchIndex）
- **責務**: Vector検索の実行
- **操作**: 検索、インデックス更新
- **形式**: ベクトル化されたデータ

**重要**: データの保存と検索テーブルは別で管理

### 3. 検索対象データ

#### 基本検索対象
- **最新版の文書**: デフォルトの検索対象
- **分割データ**: 文書を章ごとに分割したデータ

#### データの状態管理
- **Clean状態**: 文書と分割データが一致
- **Dirty状態**: 文書と分割データが不一致
  - Dirtyデータは順次更新される（古いものから順次）
  - 時間差が発生することを前提とした設計

### 4. 文書の分割

#### 分割深度（Depth）
- **範囲**: 0〜3段
- **方式**: トークン数に基づく動的分割
- **基準**: 章立てによる機械的な分割

#### 分割アルゴリズム
```
1. 大きなセクション（H1, H2など）で分割
2. セクションのトークン数を計測
3. 一定以上のトークン数の場合:
   - サブセクション（H3, H4など）でさらに分割
   - 再帰的に繰り返し（depth=3まで）
4. 単一セクションに大量の情報がある場合:
   - それ以上分割せず、そのまま保存（諦める）
```

#### 分割の階層構造
```
文書全体 (depth=0, token=5000)
  ├── 第1章 (depth=1, token=3000) → 閾値超過、さらに分割
  │   ├── 1.1節 (depth=2, token=1500)
  │   └── 1.2節 (depth=2, token=1500)
  └── 第2章 (depth=1, token=2000) → 閾値内、これ以上分割しない
```

### 5. 検索機能

#### 検索対象の範囲
- **文書全体**: depth=0
- **文書の一部**: depth=1〜3
- **両方**: 全階層を対象

#### 検索結果のソート
- **Depthによる並び替え**: 可能
- **用途別の最適化**:
  - 詳細な情報を得たい → より深いdepth優先
  - 全体像を知りたい → より浅いdepth優先

#### 検索結果からの文書取得
- **部分取得**: 特定の章・節のみ
- **全体取得**: 文書全体
- **両方**: どちらも取得可能

## データ構造の詳細設計

### ストレージレイヤー

#### Document（文書ストレージ）
```typescript
interface Document {
  path: string;              // 文書Key（ファイルパス形式）
  title: string;             // タイトル
  content: string;           // 全文
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    fileHash?: string;       // 内容の変更検知用
    [key: string]: any;      // 拡張可能なメタデータ
  };
}
```

**インターフェイス分離の例**:
```typescript
interface DocumentStorage {
  save(path: string, document: Document): Promise<void>;
  get(path: string): Promise<Document | null>;
  delete(path: string): Promise<void>;
  list(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
```

### 検索レイヤー

#### Section（分割データ）
```typescript
interface Section {
  id: string;                // セクションID
  documentPath: string;      // 元文書のパス
  heading: string;           // 見出し
  depth: number;             // 深度（0〜3）
  content: string;           // 内容
  tokenCount: number;        // トークン数
  vector: Float32Array;      // ベクトル表現
  parentId: string | null;   // 親セクションID
  order: number;             // 文書内の順序
  isDirty: boolean;          // Dirtyフラグ
  // メタデータフィールド（フラット構造）
  documentHash: string;      // 対応する文書のハッシュ
  createdAt: Date;           // 作成日時
  updatedAt: Date;           // 更新日時
  summary?: string;          // セクションの要約（後で生成）
  documentSummary?: string;  // 文書全体の要約（コンテキスト保持用）
}
```

**設計上の注意**:
- **フラット構造を採用**: `metadata`ネストを使用せず、すべてのフィールドをトップレベルに配置
- **理由**: PyArrow/LanceDBのパフォーマンス最適化のため
  - ネストした構造はPyArrowで非効率（追加のシリアライズが必要）
  - sebas-chanプロジェクトでの実績に基づく設計判断
  - TypeScript-Python間の変換層でcamelCase↔snake_caseを処理

#### SearchIndex（検索インデックス）
LanceDBのテーブルとして実装:
```python
# PyArrowスキーマ（フラット構造）
SectionSchema = pa.schema([
    ("id", pa.string()),
    ("document_path", pa.string()),
    ("heading", pa.string()),
    ("depth", pa.int32()),
    ("content", pa.string()),
    ("token_count", pa.int32()),
    ("vector", pa.list_(pa.float32(), VECTOR_DIM)),
    ("parent_id", pa.string()),
    ("order", pa.int32()),
    ("is_dirty", pa.bool_()),
    # メタデータフィールド（フラット構造）
    ("document_hash", pa.string()),
    ("created_at", pa.timestamp('ms')),
    ("updated_at", pa.timestamp('ms')),
    # 将来の拡張用（オプショナル）
    # ("summary", pa.string()),           # セクションの要約
    # ("document_summary", pa.string())   # 文書全体の要約
])
```

**実装上の注意**:
- TypeScript側はcamelCase（`documentPath`, `tokenCount`など）
- Python側はsnake_case（`document_path`, `token_count`など）
- db-engineの変換層で自動的に相互変換を行う

## 状態遷移

### 文書追加・更新時
```
1. DocumentStorageに文書を保存
   - path, content, metadataを保存
   - 文書のハッシュを計算

2. 既存の分割データをチェック
   - document_pathで検索
   - 文書ハッシュが異なる場合、is_dirty=trueにマーク

3. バックグラウンドで分割・インデックス処理
   - Markdown解析
   - トークン数計測
   - 再帰的分割
   - ベクトル化
   - SearchIndexに保存（is_dirty=false）

4. 古いDirtyデータを削除
```

### Dirty更新プロセス
```
1. is_dirty=trueのレコードを取得（古い順）
2. 対応する文書をDocumentStorageから取得
3. 再分割・再ベクトル化
4. SearchIndexを更新（is_dirty=false）
5. 次のDirtyデータへ
```

### 削除時
```
1. DocumentStorageから文書を削除
2. SearchIndexから関連するセクションを削除
   - document_pathで検索して一括削除
```

## 検索フロー

### 基本検索
```
1. クエリをベクトル化
2. LanceDBでVector検索
   - depthでフィルタリング（オプション）
   - is_dirty=falseを優先
3. 結果をdepthでソート
4. document_pathから元文書への参照を返す
```

### 詳細取得
```
1. 検索結果のdocument_pathを使用
2. DocumentStorage.get(path)で文書全体を取得
3. 要求に応じて:
   - 部分: section.contentを返す
   - 全体: document.contentを返す
   - 関連: parent_idを辿って親子セクションを取得
```

## 実装上の考慮事項

### ストレージインターフェイス分離
- **目的**: 将来的なバージョン管理対応
- **実装**: DocumentStorageインターフェイスを定義
- **拡張性**: Git連携などを後から実装可能

### トークン数の計測
- tiktoken等のトークナイザーを使用
- モデルに応じた適切な閾値設定
- 閾値の設定例:
  - 最大セクションサイズ: 2000トークン
  - 最小分割サイズ: 100トークン

### Dirty管理
- バックグラウンドワーカーでの処理
- 更新順序: 古いものから順次（created_atの昇順）
- 処理の並列化: 複数文書を同時処理可能

### 分割戦略
- Markdown見出しレベル（#, ##, ###, ####）で分割
- 見出しがない場合の対応:
  - 段落単位での分割
  - または分割しない（depth=0のみ）

### パス管理
- 相対パス vs 絶対パス: プロジェクトルートからの相対パス推奨
- パス正規化: 一貫性のための正規化処理
- 移動対応: パスが変更された場合の対応方法

## アーキテクチャ図

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│  - 文書追加/更新/削除                   │
│  - 検索クエリ実行                       │
└──────────────┬──────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
┌───────▼──────┐ ┌───▼──────────────┐
│ DocumentStorage│ │ SearchIndex      │
│  (File/DB)    │ │  (LanceDB)       │
│               │ │                  │
│ - path        │ │ - vector search  │
│ - content     │ │ - depth filter   │
│ - metadata    │ │ - dirty管理      │
└───────────────┘ └──────────────────┘
```

## 次のステップ

1. ✅ データモデルの確定
2. 🔲 DocumentStorageインターフェイスの実装
3. 🔲 LanceDBスキーマの実装
4. 🔲 Markdown分割ロジックの実装
5. 🔲 トークン計測とベクトル化の実装
6. 🔲 Dirty管理ワーカーの実装
