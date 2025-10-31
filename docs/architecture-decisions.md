# アーキテクチャ決定記録 (ADR)

## 概要

このドキュメントは、search-docsプロジェクトにおける重要なアーキテクチャ決定とその理由を記録します。

---

## ADR-001: TypeScript + Pythonのハイブリッド構成

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

ベクトル検索システムの実装にあたり、以下の要件がある:
- Node.js/TypeScriptエコシステムとの統合（メインプロジェクト言語）
- LanceDB、sentence-transformersなどPythonライブラリの活用
- 型安全性の確保
- 開発・デバッグの容易性

### 検討した選択肢

#### 1. Python単体
**長所**:
- LanceDB、ML系ライブラリのネイティブサポート
- 実装が単純

**短所**:
- Node.jsプロジェクトとの統合が複雑
- TypeScriptの型システムを活かせない
- Claude Codeとの統合が困難

#### 2. TypeScript単体
**長所**:
- プロジェクト全体で言語統一
- 型安全性

**短所**:
- LanceDBのTypeScriptバインディングが未成熟
- sentence-transformersの代替が限定的
- ML系のエコシステムが弱い

#### 3. TypeScript + Python（採用）
**長所**:
- 各言語の強みを活かせる
- 既存のPythonライブラリを活用
- TypeScriptで型安全なインターフェイス提供
- JSON-RPCで明確な境界

**短所**:
- 2言語の管理が必要
- プロセス間通信のオーバーヘッド

### 決定

TypeScript + Pythonのハイブリッド構成を採用。

**理由**:
1. sebas-chanプロジェクトで実績あり
2. LanceDB、sentence-transformersの成熟したエコシステム
3. TypeScriptでビジネスロジック、Pythonでベクトル処理と明確な責務分離
4. JSON-RPCによる疎結合な設計

### 影響

- 開発環境にPython（uv）とNode.js（pnpm）が必要
- JSON-RPC通信のオーバーヘッド（通常は無視できるレベル）
- デバッグ時に2プロセスの追跡が必要

---

## ADR-002: JSON-RPC 2.0による通信プロトコル

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

TypeScriptとPython間の通信方法を決定する必要がある。

### 検討した選択肢

#### 1. REST API
**長所**:
- 標準的、デバッグツールが豊富

**短所**:
- HTTPサーバのオーバーヘッド
- ポート管理が必要
- ローカルプロセスには過剰

#### 2. gRPC
**長所**:
- 高速、型定義

**短所**:
- セットアップが複雑
- デバッグが困難
- ローカル通信には過剰

#### 3. JSON-RPC over stdin/stdout（採用）
**長所**:
- シンプル、軽量
- プロセス管理が容易
- デバッグが簡単（JSON出力）
- 標準仕様（JSON-RPC 2.0）

**短所**:
- 大きなペイロードで制限あり（8KB程度）
- バイナリデータに非効率

### 決定

JSON-RPC 2.0 over stdin/stdoutを採用。

**理由**:
1. sebas-chanで実績あり
2. デバッグが容易（JSON出力を直接確認）
3. プロセスのライフサイクル管理がシンプル
4. 現状のユースケースでは8KB制限が問題にならない

### 影響

- 大きなセクション（8KB以上）の送信に制約
- 将来的にIPC通信への移行を検討する必要あり
- stderr出力でデバッグ情報を分離

### 将来の改善

- チャンク分割送信の実装
- バッファサイズの拡張
- IPC（Inter-Process Communication）への移行

---

## ADR-003: トークンベースの文書分割

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

Markdown文書を検索可能な単位に分割する必要がある。

### 検討した選択肢

#### 1. 文字数ベース
**長所**:
- 実装が簡単

**短所**:
- LLMのコンテキストウィンドウと対応しない
- 言語により情報密度が異なる

#### 2. 段落ベース
**長所**:
- 意味的なまとまり

**短所**:
- 段落サイズが不均一
- 大きすぎる/小さすぎる段落の処理が困難

#### 3. トークンベース（採用）
**長所**:
- LLMのコンテキストウィンドウと整合
- 検索結果のサイズが予測可能
- 言語に依存しない

**短所**:
- トークン計測のオーバーヘッド
- tiktoken等のライブラリが必要

### 決定

トークンベースの分割を採用。

**閾値**:
- 最大トークン数: 2000 (maxTokensPerSection)
- 最小分割トークン数: 100 (minTokensForSplit)

**理由**:
1. LLMへの入力サイズと直接対応
2. 検索結果のトークン数を制御可能
3. 言語（日本語/英語）に依存しない分割

### 影響

- tiktoken等のトークンカウンターが必要（Phase 2で実装）
- 初回インデックス作成時のトークン計測コスト
- 再分割時の計算コスト

---

## ADR-004: 階層的セクション構造（depth 0-3）

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

Markdownの見出し階層をどこまで保持するか決定する必要がある。

### 検討した選択肢

#### 1. フラット構造
**長所**:
- シンプル

**短所**:
- 文書構造が失われる
- コンテキストの復元が困難

#### 2. 完全な階層（H1-H6）
**長所**:
- 元の文書構造を完全に保持

**短所**:
- 深すぎる階層は検索精度を低下させる
- 複雑性の増加

#### 3. 制限付き階層 depth 0-3（採用）
**長所**:
- 主要な構造を保持
- 検索時の階層フィルタが有効
- 過度に深い階層を防ぐ

**短所**:
- H4以降は無視される

### 決定

depth 0-3の4階層構造を採用。

**マッピング**:
- depth 0: 文書全体（見出しなし、または前文）
- depth 1: H1セクション
- depth 2: H2セクション
- depth 3: H3セクション

**理由**:
1. 一般的なドキュメントの構造に適合
2. H4以降は細かすぎて検索対象として不適切
3. 階層フィルタによる絞り込みが実用的

### 影響

- H4-H6の見出しは親セクションに含まれる
- 検索時に階層フィルタが使用可能（例: depth=[1,2]でH1,H2のみ）

---

## ADR-005: Dirtyフラグによる非同期更新

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

ファイル変更時の再インデックス戦略を決定する必要がある。

### 検討した選択肢

#### 1. 即時更新
**長所**:
- データが常に最新

**短所**:
- ファイル保存のたびにブロック
- 大きなファイルで遅延
- ユーザー体験の低下

#### 2. 完全な非同期更新
**長所**:
- ブロックしない

**短所**:
- 更新中のセクションが検索結果に含まれる
- データ不整合のリスク

#### 3. Dirtyフラグ + バックグラウンド更新（採用）
**長所**:
- ファイル保存をブロックしない
- Dirtyフラグで更新状態を追跡
- `includeCleanOnly`で一貫性を制御

**短所**:
- 実装がやや複雑
- Dirtyセクションの管理が必要

### 決定

Dirtyフラグによる非同期更新を採用。

**フロー**:
1. ファイル変更検出
2. `markDirty(documentPath)` → 該当セクションに`isDirty=true`
3. バックグラウンドワーカーが`getDirtySections()`で取得
4. 古い順（`created_at`）に再インデックス
5. 完了後、古いセクション削除 + 新しいセクション挿入（`isDirty=false`）

**理由**:
1. ユーザー操作（ファイル保存）をブロックしない
2. 検索時に`includeCleanOnly`で一貫性を選択可能
3. 優先度制御が可能（古い更新を優先）

### 影響

- 検索結果にDirtyフラグが含まれる
- クライアント側で「更新中」の表示が可能
- バックグラウンドワーカーの実装が必要（Phase 2）

---

## ADR-006: cl-nagoya/ruri埋め込みモデルの採用

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

日本語文書の埋め込みモデルを選定する必要がある。

### 検討した選択肢

#### 1. OpenAI Embeddings
**長所**:
- 高精度

**短所**:
- API課金
- オフラインで使用不可
- レイテンシ

#### 2. multilingual-e5
**長所**:
- 多言語対応
- オープンソース

**短所**:
- 日本語特化ではない
- モデルサイズが大きい

#### 3. cl-nagoya/ruri（採用）
**長所**:
- 日本語特化
- 複数サイズ（30m/310m）
- MRL対応（次元削減可能）
- ローカル実行

**短所**:
- 英語の精度は劣る可能性

### 決定

cl-nagoya/ruriシリーズを採用。

**デフォルト**: ruri-v3-30m (256次元、120MB)
**オプション**: ruri-v3-310m (768次元、1.2GB)

**理由**:
1. sebas-chanプロジェクトで実績
2. 日本語ドキュメントに最適化
3. MRLにより次元削減可能（768→256）
4. ローカル実行でプライバシー保護
5. メモリ使用量のバランス

### 影響

- 初回起動時にモデルダウンロード（数分）
- 日本語文書に最適化される一方、英語は劣る可能性
- オフライン環境で動作

### 将来の拡張

- 他のモデルへの切り替え対応（インターフェイス分離済み）
- モデルのホットスワップ

---

## ADR-007: uvによるPython環境管理

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

Pythonの依存関係管理ツールを選定する必要がある。

### 検討した選択肢

#### 1. pip + venv
**長所**:
- 標準ツール

**短所**:
- 遅い
- ロックファイルが非標準
- 再現性に課題

#### 2. poetry
**長所**:
- 高機能
- ロックファイル

**短所**:
- 起動が遅い
- 依存解決が遅い

#### 3. uv（採用）
**長所**:
- 超高速（Rust実装）
- pip互換
- pyproject.toml標準
- ロックファイル対応

**短所**:
- 比較的新しいツール

### 決定

uvを採用。

**理由**:
1. sebas-chanプロジェクトで採用済み
2. 高速な依存解決・インストール
3. pyproject.toml標準仕様に準拠
4. ユーザーフレンドリー

### 影響

- ユーザーはuvのインストールが必要
- `uv sync`で環境構築
- CI/CDでの高速化

---

## ADR-008: FileStorageのJSON形式

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

DocumentStorageの実装形式を決定する必要がある。

### 検討した選択肢

#### 1. SQLite
**長所**:
- トランザクション
- クエリ機能

**短所**:
- オーバーヘッド
- バージョン管理が複雑

#### 2. JSON（採用）
**長所**:
- シンプル
- 可読性
- Git管理可能

**短所**:
- トランザクションなし
- 大量ファイルでのパフォーマンス

### 決定

JSON形式でファイル保存を採用。

**理由**:
1. v1では大量ファイルを想定しない
2. デバッグが容易
3. Git管理可能（オプション）
4. 実装がシンプル

### 影響

- `.search-docs/storage/`ディレクトリにJSON保存
- トランザクションはアプリケーション層で管理
- 将来的にSQLiteへ移行可能（インターフェイス分離済み）

---

## ADR-009: パス正規化とセキュリティ

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

ファイルパスの扱いとセキュリティ対策を決定する必要がある。

### 決定

以下の対策を実施:

1. **パス正規化**: `path.normalize()`でWindows/Unix互換
2. **ディレクトリトラバーサル対策**: `..`を含むパスを除去
3. **UNIX形式**: 内部的にスラッシュ区切り（`/`）を使用

**実装**:
```typescript
private getFilePath(docPath: string): string {
  const normalized = path.normalize(docPath);
  const safePath = normalized.replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(this.baseDir, safePath + '.json');
}
```

**理由**:
1. Windows/Unixの両対応
2. セキュリティリスクの低減
3. 一貫したパス表現

### 影響

- `../../etc/passwd`のような悪意あるパスを無害化
- クロスプラットフォームでの一貫性

---

## ADR-010: LanceDBのスキーマ定義にPyArrowを使用

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

LanceDBのスキーマ定義方法を決定する必要がある。

### 検討した選択肢

#### 1. Pandasデータフレーム
**長所**:
- シンプル

**短所**:
- 型情報が曖昧
- パフォーマンス

#### 2. PyArrow Schema（採用）
**長所**:
- 型安全
- LanceDBネイティブサポート
- パフォーマンス

**短所**:
- やや冗長

### 決定

PyArrow Schemaを採用。

**理由**:
1. LanceDBの推奨方法
2. 型安全性
3. パフォーマンス

### 影響

- スキーマ定義が明示的
- 型不一致エラーを早期検出
- バリデーション機能の実装が容易

---

## ADR-011: 階層的コンテンツによるベクトル検索精度向上

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム
**関連コミット**: e9d0104, f04918c

### コンテキスト

初期実装では、各セクションが**独立したコンテンツのみ**を持っており、階層的な意味構造が検索時に失われる問題があった。

**具体的な問題**:
1. 親セクション（H1, H2）に子セクション（H2, H3）のコンテンツが含まれない
2. depth=0が「見出しのない前文」のみで、文書全体を表していない
3. セクション単体では「何についての情報か」が不明確

**検索時の影響**:
- クエリ「Node.jsプロジェクトのnpmインストール方法」
- H1セクション: 子の内容が含まれないため"npm install"にマッチしない
- H2セクション: "インストール手順"という見出しのみで具体的手順が含まれない
- 断片的な情報のみで、コンテキストが失われている

### 検討した選択肢

#### 1. 現状維持（独立コンテンツ）
**長所**:
- 実装がシンプル
- トークン数が少ない

**短所**:
- 検索精度が低い
- セクション単体でコンテキストが不明
- マクロレベル（文書全体）での検索ができない

#### 2. 複数ベクトルアプローチ
**内容**: セクションコンテンツ、親セクション情報、文書サマリを別々にベクトル化

**長所**:
- 各情報を独立して管理
- 柔軟な検索戦略

**短所**:
- 実装が複雑
- ベクトル数が増加（ストレージ・検索コスト）
- 結果のマージロジックが必要

#### 3. 階層的コンテンツ（単一ベクトル）（採用）
**内容**: 親セクションに子のコンテンツを再帰的に含め、単一ベクトルで完全な意味を保持

**長所**:
- 単一ベクトルで完全な意味を保持
- コンテキストが自然言語として含まれる
- ベクトル検索が正確に機能
- 実装がシンプル

**短所**:
- トークン数が増加する
- 将来的にLLMサマリ生成が必要（Phase 2）

### 決定

階層的コンテンツ（単一ベクトル）アプローチを採用。

**実装内容**:

1. **親セクションに子のコンテンツを再帰的に含める**
```typescript
private buildContent(node: HeadingNode): string {
  let text = '';

  // 見出しを追加
  if (node.heading) {
    const prefix = '#'.repeat(Math.max(1, node.depth));
    text += `${prefix} ${node.heading}\n\n`;
  }

  // 自分のコンテンツを追加
  text += node.content.join('\n\n');

  // 子のコンテンツを再帰的に追加
  if (node.children.length > 0) {
    for (const child of node.children) {
      text += '\n\n' + this.buildContent(child);
    }
  }

  return text.trim();
}
```

2. **depth=0を文書全体として定義**
- すべてのH1セクションを子として持つ
- contentフィールドに文書全体のコンテンツを含む

3. **各depthレベルで完全な意味を保持**
- depth=0: 文書全体（すべてのH1, H2, H3を含む）
- depth=1: H1 + その下のすべてのH2, H3
- depth=2: H2 + その下のすべてのH3
- depth=3: H3のみ

**理由**:
1. マクロ（文書全体）とミクロ（セクション）の両面で検索可能
2. セクション単体でコンテキストが失われる問題を解決
3. 単一ベクトルでシンプルな実装
4. Phase 2（LLMサマリ統合）への布石

### 影響

**ポジティブ**:
- 検索精度の大幅な向上
- "Node.jsのnpmインストール"で文書全体〜小節まで段階的にマッチ
- セクション単体で意味が完結

**ネガティブ**:
- トークン数増加（対処: maxTokensPerSection超過時に警告）
- ベクトルサイズの増加（対処: 各depthで適切な粒度を維持）
- 既存インデックスの再構築が必要

**トークン数管理**:
```typescript
// トークン数超過時に警告（分割はしない）
if (tokenCount > this.config.maxTokensPerSection) {
  console.warn(
    `Section "${heading || '(document root)'}" in ${documentPath} ` +
    `exceeds maxTokensPerSection (${tokenCount} > ${this.config.maxTokensPerSection})`
  );
}
```

### 実装履歴

**Phase 1（完了）**:
1. ✅ `buildContent()`を修正: 子のコンテンツを再帰的に含める
2. ✅ `extractHeadingStructure()`を修正: depth=0を文書全体に
3. ✅ トークン数警告機能
4. ✅ テスト全面更新（25テストケース）
5. ✅ バグ修正（H3コンテンツ追加、Glob→Regex変換）

**Phase 2（将来）**:
- LLMでサマリ生成
- contentフィールドにサマリを統合
- 単一ベクトルで完全なコンテキスト保持

### 関連ドキュメント

- 詳細設計: `docs/hierarchical-content-issue.md`
- 実装: `packages/server/src/splitter/markdown-splitter.ts`
- テスト: `packages/server/src/splitter/__tests__/markdown-splitter.test.ts`

### 将来の拡張

**LLMサマリ統合（Phase 2）**:

各セクションのcontentフィールドに文書全体のサマリを統合し、単一ベクトルで完全なコンテキストを保持する。

```typescript
const content = `
Document: ${documentSummary.title}
${documentSummary.summary}

---

${section.content}
`;
```

これにより、小セクション（depth=3）でも文書全体のコンテキストが保持され、以下の検索が可能になる:
- 「Node.jsのセットアップ」→ 文書サマリにマッチ
- 「npmインストール」→ セクションコンテンツにマッチ
- 「Node.jsプロジェクトのnpmインストール」→ サマリ+コンテンツの両方にマッチ

**注**: ハイブリッド検索（複数ベクトル）は採用せず、単一ベクトルアプローチを維持する。

---

## ADR-012: Section型のフラット構造採用

**日付**: 2025-01-27
**状態**: 採用
**決定者**: 実装チーム
**関連コミット**: 4dce5a5, 086097c

### コンテキスト

db-engineテストの実装中に、TypeScript型定義とPython実装の間でSection型の構造に不一致が発見された。

**TypeScript型定義（初期）**:
```typescript
interface Section {
  // ...基本フィールド
  metadata: {
    documentHash: string;
    createdAt: Date;
    updatedAt: Date;
    summary?: string;
    documentSummary?: string;
  };
}
```

**Python DBスキーマ（初期）**:
```python
# フラット構造
pa.field("document_hash", pa.string()),
pa.field("created_at", pa.timestamp('ms')),
pa.field("updated_at", pa.timestamp('ms'))
```

**問題**:
- TypeScript: ネスト構造（`section.metadata.documentHash`）
- Python: フラット構造（`section.document_hash`）
- TypeScript→Python変換層が欠落
- データモデル文書内でも矛盾

### 検討した選択肢

#### 1. TypeScript型定義（ネスト構造）を正とする
**内容**: Python側をネスト構造に変更、またはTypeScript→Python変換層を実装

**長所**:
- TypeScript側が「正規仕様」として明確
- `metadata`という意味的なグループ化がある

**短所**:
- TypeScript-Python変換層の実装が必要（双方向変換）
- 変換オーバーヘッド
- PyArrowでのネスト構造（Struct型）は性能面で不利
- メンテナンス負担の増加

#### 2. Python DBスキーマ（フラット構造）を正とする（採用）
**内容**: TypeScript型定義をフラット構造に変更、Python DBスキーマと一致させる

**長所**:
- TypeScript Section型 ≡ Python DBスキーマ（完全一致）
- 変換ロジック不要（camelCase↔snake_caseのみ）
- PyArrowフラット構造の性能的利点
- コードが理解しやすい
- バグが入りにくい

**短所**:
- `metadata`という意味的なグループ化が失われる
- 既存の実装（markdown-splitter.ts等）の修正が必要

### 決定

**フラット構造を正規仕様として採用**し、TypeScript型定義をPython DBスキーマに合わせる。

**最終的なSection型**:
```typescript
interface Section {
  id: string;
  documentPath: string;
  heading: string;
  depth: number;
  content: string;
  tokenCount: number;
  vector: Float32Array;
  parentId: string | null;
  order: number;
  isDirty: boolean;
  // メタデータフィールドをフラット化
  documentHash: string;
  createdAt: Date;
  updatedAt: Date;
  summary?: string;
  documentSummary?: string;
}
```

**理由**:

1. **PyArrow/LanceDBのパフォーマンス最適化**
   - ネスト構造（Struct型）はPyArrowで非効率（追加のシリアライズが必要）
   - フラット構造が推奨される設計パターン

2. **sebas-chanプロジェクトの実績**
   - 参照プロジェクト（sebas-chan）でフラット構造を採用
   - 明確な2層アーキテクチャ：
     - アプリケーション層（TypeScript）: camelCase
     - DB層（LanceDB/PyArrow）: フラット構造、snake_case

3. **シンプルさの価値**
   - 変換層の実装コストを正当化できない
   - `documentHash`, `createdAt`, `updatedAt`は実質的に必須フィールド
   - ネストによる「意味的なグループ化」の実用的メリットが小さい

4. **実用性**
   - search-docsでは配列やネストしたオブジェクトが存在しない
   - sebas-chanのように複雑な構造（`updates: IssueUpdate[]`）をJSON文字列化する必要がない

### 影響

**ポジティブ**:
- TypeScript-Python間のデータ構造が完全一致
- 変換オーバーヘッドなし
- パフォーマンス向上（PyArrowフラット構造の利点）
- メンテナンス負担の軽減
- バグの可能性が低減

**ネガティブ**:
- `metadata`という意味的なグループ化の喪失
- 既存実装の修正が必要

**必要な修正**:
1. ✅ `packages/types/src/section.ts`: フラット構造に変更
2. ✅ `packages/server/src/splitter/markdown-splitter.ts`: フラット構造でSection生成
3. ✅ `packages/db-engine/src/typescript/index.ts`: camelCase↔snake_case変換層
4. ✅ `packages/db-engine/src/python/schemas.py`: vectorを必須フィールドから削除
5. ✅ `packages/db-engine/src/python/worker.py`: datetime変換追加
6. ✅ `packages/server/src/splitter/__tests__/markdown-splitter.test.ts`: フラット構造に対応
7. ✅ `docs/data-model.md`: Section型のフラット構造を反映

### 変換層の実装

TypeScript側（camelCase）とPython側（snake_case）の命名規則の違いは、db-engineの変換層で吸収：

```typescript
private convertSectionToPythonFormat(section: Omit<Section, 'vector'>): unknown {
  return {
    id: section.id,
    document_path: section.documentPath,
    heading: section.heading,
    depth: section.depth,
    content: section.content,
    token_count: section.tokenCount,
    parent_id: section.parentId,
    order: section.order,
    is_dirty: section.isDirty,
    document_hash: section.documentHash,
    created_at: section.createdAt,
    updated_at: section.updatedAt,
    summary: section.summary,
    document_summary: section.documentSummary,
  };
}
```

### 関連ドキュメント

- 詳細調査レポート: `prompts/tasks/research-report.section-type-structure.v1.md`
- データモデル設計: `docs/data-model.md`
- 実装: `packages/types/src/section.ts`
- 変換層: `packages/db-engine/src/typescript/index.ts`

### 学んだ教訓

1. **性能面の考慮の重要性**: 型の「意味的な正しさ」だけでなく、性能面も評価すべき
2. **シンプルさの価値**: YAGNI原則 - 実用的なメリットがない複雑さは避けるべき
3. **参照実装の重要性**: sebas-chanプロジェクトの調査が決定的だった

---

## まとめ

これらの決定により、以下の特性を持つシステムが構築された:

1. **ハイブリッド構成**: TypeScriptとPythonの強みを活かす
2. **型安全性**: TypeScriptの型システム、PyArrowスキーマ
3. **シンプルさ**: JSON-RPC、JSON Storage、フラット型構造
4. **日本語最適化**: Ruriモデル
5. **非同期更新**: Dirtyフラグによる柔軟な更新管理
6. **クロスプラットフォーム**: Windows/Unix両対応
7. **階層的検索**: マクロ・ミクロ両面での高精度検索
8. **パフォーマンス最適化**: PyArrowフラット構造、変換層の最小化

## ADR-013: CLIサーバプロセス管理の実装方針

**日付**: 2025-10-28
**状態**: 採用
**決定者**: 実装チーム
**関連**: CLI実装、サーバプロセス管理

### コンテキスト

search-docs CLIツールでサーバプロセスを管理する機能を実装するにあたり、以下の要件を満たす必要がある：

1. **1プロジェクト1サーバプロセス**: 各プロジェクトディレクトリごとに最大1つのサーバプロセスを起動
2. **複数プロジェクト対応**: 異なるプロジェクトでは同時に複数サーバを起動可能
3. **プロセス管理**: サーバの起動・停止・状態確認を安全に実行
4. **異常終了対応**: サーバが異常終了した場合の復旧
5. **クロスプラットフォーム**: Windows/macOS/Linuxで動作

### 検討した選択肢と決定

#### 1. プロジェクト識別とPIDファイル管理

**決定内容**:
- プロジェクトルートの正規化された絶対パスで識別
- シンボリックリンクを解決して実体パスを使用
- PIDファイル配置: `<project-root>/.search-docs/server.pid`
- 形式: JSON、パーミッション: `0600`

**PIDファイル内容**:
```json
{
  "pid": 12345,
  "startedAt": "2025-10-28T15:00:00.000Z",
  "projectRoot": "/Users/user/my-project",
  "projectName": "my-project",
  "host": "localhost",
  "port": 24280,
  "configPath": "/Users/user/my-project/.search-docs.json",
  "version": "0.1.0",
  "nodeVersion": "v22.11.0"
}
```

**理由**:
- 固定名のPIDファイル: 1プロジェクト1サーバなので複雑な命名スキーム不要
- プロジェクトルート内配置: プロジェクト固有の状態として管理、.gitignore対象
- JSON形式: 将来的な拡張性、デバッグ時の可読性
- 0600パーミッション: セキュリティ強化、他ユーザーによる不正操作防止
- メタ情報の保存: デバッグやトラブルシューティングに有用

**不採用案**: グローバルなPIDファイル管理（システム全体で1ヶ所に集約）
- 複雑な命名スキーム（プロジェクトパスのハッシュ等）が必要
- プロジェクト削除時にPIDファイルが残留する可能性

#### 2. プロジェクトルートの決定方法

**決定内容**: 以下の優先順位でプロジェクトルートを決定
1. 設定ファイルの`project.root`フィールド（最優先）
2. 設定ファイルの親ディレクトリ（`--config`オプション指定時）
3. カレントワーキングディレクトリ（デフォルト）

**正規化処理**:
```typescript
async function normalizeProjectRoot(root: string): Promise<string> {
  const absolutePath = path.resolve(root);
  const realPath = await fs.realpath(absolutePath);
  return realPath.replace(/\/$/, '');
}
```

**理由**:
- 明示性: ユーザーが意図したプロジェクトルートを確実に使用
- 柔軟性: 設定ファイルの場所とプロジェクトルートを分離可能
- 一貫性: 常に絶対パスで管理、シンボリックリンクの影響を排除

**不採用案**: .gitディレクトリベースの検索
- Gitリポジトリでないプロジェクトには対応不可
- モノレポ構成で誤動作の可能性

#### 3. 重複起動防止の3段階チェック

**決定内容**: サーバ起動時に以下の3段階でチェック

1. **PIDファイルの存在確認**
2. **プロセス生存確認**: `process.kill(pid, 0)`（シグナル0で存在確認のみ）
3. **ポート利用可能性確認**: `net.createServer`で試行

**理由**:
- PIDファイル存在確認: 高速な初期チェック
- プロセス生存確認: PIDファイルが古い（異常終了）場合を検出
- ポート確認: プロセスは生きているが別のサービスがポート使用中を検出

#### 4. クロスプラットフォーム対応

**決定内容**:
- **Unix系 (macOS/Linux)**: `process.kill(pid, 'SIGTERM')` → タイムアウト後 `SIGKILL`
- **Windows**: `taskkill /PID <pid> /T` → タイムアウト後 `/F /T`

**理由**:
- Node.js標準API優先: `process.kill()`はNode.js標準で可搬性が高い
- Windowsの特性考慮: SIGTERMが完全にサポートされていないため`taskkill`使用
- サブプロセス終了: `/T`フラグでサブプロセスも確実に終了

**不採用案**: pm2などのプロセス管理ツール使用
- 外部依存が増える
- ユーザーの環境に依存

#### 5. デーモン化の実装方法

**決定内容**:
```typescript
const serverProcess = spawn('node', [serverScript], {
  detached: true,           // 親プロセスから切り離し
  stdio: ['ignore', 'ignore', 'ignore'],
});
serverProcess.unref();      // 親プロセス終了を待たない
```

**理由**:
- シンプルな実装: Node.js標準APIのみで実現
- 外部依存なし: pm2等の外部ツール不要
- 拡張性: ログファイル対応を後から追加可能

**将来的なログ出力対応**:
```typescript
const logFd = fs.openSync(logPath, 'a');
stdio: ['ignore', logFd, logFd]
```

#### 6. 異常終了時の復旧戦略

**決定内容**:
1. PIDファイル読み込み
2. プロセス生存確認（`isProcessAlive(pid)`）
3. プロセスが停止している場合、古いPIDファイルを自動削除
4. 通常の起動フローを実行

**理由**:
- ユーザー介入不要: 異常終了後も自動で復旧
- 透明性: 警告メッセージで状況を通知
- 安全性: プロセスが既に停止していることを確認してから削除

#### 7. ポート管理戦略

**決定内容**:
- デフォルトポート: `24280`
- ポート指定: `--port <port>`オプション、または設定ファイル`server.port`
- 複数プロジェクト対応: 各プロジェクトで異なるポートを使用
- ポート競合時: エラーで起動中止

**理由**:
- デフォルト24280: 一般的なサービスと競合しにくい
- 明示的なポート指定: ユーザーが制御可能
- 競合時エラー: 意図しない動作を防止

**将来の拡張**: `--port auto`で空きポートを自動検索

#### 8. ヘルスチェック戦略

**決定内容**: 2段階の生存確認
1. **プロセスレベル**: `process.kill(pid, 0)`
2. **アプリケーションレベル**: `GET /health`

```typescript
async function checkServerHealth(
  host: string,
  port: number,
  timeout: number = 3000
): Promise<boolean> {
  const response = await fetch(`http://${host}:${port}/health`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (response.ok) {
    const data = await response.json();
    return data.status === 'ok';
  }
  return false;
}
```

**理由**:
- プロセスレベル: 高速、OS標準機能
- アプリケーションレベル: サーバが正常に応答しているか確認
- タイムアウト設定: 無限待機を防止

### 影響

**実装への影響**:
- ユーティリティ層: `pid.ts`, `process.ts`, `project.ts`
- コマンド層: `server/start.ts`, `server/stop.ts`, `server/status.ts`, `server/restart.ts`

**ユーザー体験への影響**:
- 透明性: 起動・停止の状態が明確
- 安全性: 重複起動防止、異常終了からの自動復旧
- 柔軟性: 複数プロジェクトで同時使用可能

**保守性への影響**:
- モジュール分離: 責務が明確で拡張しやすい
- テスタビリティ: 各ユーティリティが独立してテスト可能
- 文書化: `docs/server-process-management.md`で詳細に記録

### 実装状況

- **実装完了**: 2025-10-28
- **コミット**: `2c30951 feat(cli): serverコマンド（start/stop/status）を実装`
- **テスト**: ビルド成功、lint成功、E2Eテスト通過

### 今後の拡張

1. ログファイル出力: デーモンモード時のログ保存
2. 自動ポート割り当て: `--port auto`対応
3. プロセス監視: 自動再起動機能（オプション）
4. 詳細なステータス: CPU/メモリ使用量の表示
5. クリーンアップコマンド: 手動での古いPIDファイル削除（`server clean`）

### 関連ドキュメント

- 詳細仕様: `docs/server-process-management.md`
- 実装計画: `prompts/tasks/task4.cli-remaining-commands.v1.md`

---

## ADR-014: IndexRequestテーブルによる非同期インデックス管理

**日付**: 2025-10-30
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

Task 6で発見された問題：
- **問題C**: 設計書（Dirtyマーキングシステム）と実装（同期的削除→追加）が乖離
- 設計書では非同期更新を想定していたが、実装は即座に整合性を保つ方式だった
- ファイル更新時の高速応答とインデックス生成の時間がかかる処理の両立が必要

### 検討した選択肢

#### 1. 単純なDirtyマーキング
**方式**:
- `is_dirty`フラグでセクションをマーク
- バックグラウンドワーカーで順次更新

**長所**:
- 設計書に忠実
- 実装がシンプル

**短所**:
- 同じファイルに複数回更新がある場合の扱いが曖昧
- デバウンス機構が必要
- 処理中の状態が不明確

#### 2. IndexRequestテーブル（採用）
**方式**:
- IndexRequestテーブルで更新要求を管理
- WorkerがLatest Onlyルールで処理（各document_path毎に最新のpendingリクエストのみ）
- 明確な状態遷移（pending → processing → completed/failed/skipped）

**長所**:
- 要求のキューイングが明示的
- 状態管理が明確（status, created_at, started_at, completed_at）
- デバウンス不要（最新のみ処理で自然に解決）
- 処理の追跡が容易
- 検索時に最新・更新中を区別可能

**短所**:
- テーブルが1つ増える
- やや複雑

### 決定

IndexRequestテーブルを導入した非同期インデックス管理を採用。

**理由**:
1. **明確な状態管理**: pending/processing/completed/failed/skippedで状態を追跡
2. **Latest Onlyルール**: 各document_path毎に最新のpendingリクエストのみ処理することで、自然にデバウンス
3. **監査可能性**: 全てのインデックス作成要求が記録される
4. **検索時の柔軟性**: 更新中のドキュメントを除外するオプションを提供可能

### アーキテクチャ

#### IndexRequestテーブル
```typescript
interface IndexRequest {
  id: string;
  documentPath: string;
  documentHash: string;  // バージョン識別子
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}
```

#### IndexWorker
```typescript
class IndexWorker {
  // 定期的にpendingリクエストをチェック
  async getNextRequests(): Promise<IndexRequest[]> {
    // 1. 全pendingリクエストを取得
    // 2. document_path毎にグループ化
    // 3. 各グループで最新（created_at降順の先頭）のみ抽出
  }

  async processRequest(request: IndexRequest): Promise<void> {
    // 1. status='processing', started_at設定
    // 2. 古いpendingをstatus='skipped'に更新
    // 3. ストレージから文書取得、ハッシュ確認
    // 4. 既存の同じハッシュのindexがあればスキップ
    // 5. セクション生成、DBに保存
    // 6. 古いindexを削除
    // 7. status='completed', completed_at設定
  }
}
```

#### ファイル更新フロー
```
1. ファイル変更検知
2. 文書をStorageに保存
3. IndexRequestを作成（status='pending'）
   ← 即座に完了（高速応答）
4. [バックグラウンド] IndexWorkerが処理
   ← 時間がかかる処理
```

### 実装フェーズ

- **Phase 1**: IndexRequestテーブル実装 ✅
- **Phase 2**: Section拡張API ✅
- **Phase 3**: IndexWorker実装 ✅
- **Phase 4**: IndexRequest作成 ✅
- **Phase 5**: 検索ロジック更新（予定）
- **Phase 6**: CLI出力更新（予定）
- **Phase 7**: 統合テスト（予定）

### 影響

**メリット**:
- ファイル更新時の即座の応答
- バックグラウンドでの非同期インデックス生成
- 高頻度更新時のデバウンス不要
- インデックス作成状況の可視化

**トレードオフ**:
- テーブルが1つ増える（管理コスト若干増）
- IndexRequestテーブルのクリーンアップが必要（完了済みレコードの定期削除）

### 関連ドキュメント

- 仕様書: `prompts/tasks/task8.dirty-marking-system-spec.v2.md`
- 問題調査: `prompts/tasks/task6.design-implementation-divergence.v1.md`
- 実装: `packages/server/src/worker/index-worker.ts`

---

## ADR-015: CLI設定管理とサーバ起動の改善

**日付**: 2025-10-30
**状態**: 採用
**決定者**: 実装チーム
**関連**: Task 10, Task 11 - CLI改善

### コンテキスト

v1.0.0リリース後、CLIの使い勝手に関する複数の問題が発見された：

1. **ポート設定の不整合**
   - サーバ起動: 設定ファイルのポート番号を正しく読む ✅
   - CLIコマンド（search, index等）: ハードコード `http://localhost:24280` を使用 ❌
   - 問題: プロジェクト毎に異なるポートで複数サーバを立ち上げられない

2. **サーバ起動のデフォルト動作**
   - フォアグラウンドがデフォルト、`--daemon` でバックグラウンド
   - 問題: 実運用ではバックグラウンドが基本、現状は使いにくい

3. **--config オプションの位置**
   - 各サブコマンドに個別定義（search, index等）
   - 問題: `search-docs --config xxx search "query"` が通らない

4. **設定ファイル探索の柔軟性不足**
   - サブディレクトリから実行すると設定が見つからない

### 検討した選択肢と決定

#### 1. ポート設定の統一的な解決

**決定内容**: `resolveServerUrl()` ユーティリティの導入

```typescript
// packages/cli/src/utils/server-url.ts
export async function resolveServerUrl(
  options: ResolveServerUrlOptions = {}
): Promise<string> {
  // 1. 明示的に指定されている場合は最優先
  if (options.server) {
    return options.server;
  }

  try {
    // 2. 設定ファイルからポート番号を取得
    const projectRoot = await findProjectRoot({
      configPath: options.config,
    });
    const configPath = await resolveConfigPath(projectRoot, options.config);
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent) as SearchDocsConfig;

    if (config.server) {
      const host = config.server.host || 'localhost';
      const port = config.server.port || 24280;
      return `http://${host}:${port}`;
    }
  } catch (error) {
    // 設定ファイルが読み込めない場合はデフォルトにフォールバック
  }

  // 3. デフォルト
  return 'http://localhost:24280';
}
```

**優先順位**:
1. `--server` オプション（明示的指定）
2. 設定ファイルの `server.host` + `server.port`
3. デフォルト: `http://localhost:24280`

**理由**:
- 設定ファイルとの一貫性確保
- 複数プロジェクトでの異なるポート使用を可能に
- 明示的指定による柔軟性維持

#### 2. サーバ起動デフォルトをバックグラウンドに変更

**変更前**:
```bash
search-docs server start           # フォアグラウンド
search-docs server start --daemon  # バックグラウンド
```

**変更後**:
```bash
search-docs server start              # バックグラウンド（デフォルト）
search-docs server start --foreground # フォアグラウンド（開発時）
```

**実装**:
```typescript
export interface ServerStartOptions {
  config?: string;
  port?: string;
  foreground?: boolean;  // daemon から foreground に変更
  log?: string;
}

// デフォルト動作を反転
const isDaemon = !options.foreground;
```

**理由**:
1. 実運用ではバックグラウンド起動が基本
2. フォアグラウンドは主に開発・デバッグ時のみ使用
3. ユーザビリティの向上（最も頻繁な操作をデフォルトに）

**MCP Serverからの起動**:
```typescript
// packages/mcp-server/src/server-manager.ts
const args = [
  'server',
  'start',
  '--foreground',  // 明示的にフォアグラウンド指定
  '--port',
  port.toString()
];
```

MCP Serverからの起動は、プロセス連動のため明示的にフォアグラウンド指定。

#### 3. グローバル --config オプション

**決定内容**: ルートレベルでのグローバルオプション定義

```typescript
// packages/cli/src/index.ts
program
  .name('search-docs')
  .description('search-docs コマンドラインツール')
  .version(packageJson.version)
  .addOption(
    new Option('-c, --config <path>', '設定ファイルのパス')
      .default(undefined)
      .env('SEARCH_DOCS_CONFIG')
  );
```

**使用例**:
```bash
# 両方通るように
search-docs --config ./custom.json search "query"
search-docs search --config ./custom.json "query"

# 環境変数も使える
export SEARCH_DOCS_CONFIG=./custom.json
search-docs search "query"
```

**理由**:
- 標準的なCLI設計パターンに準拠
- 環境変数サポートによるCI/CD対応
- ユーザー体験の向上

#### 4. 設定ファイル自動探索

**CLI（search, index等）の探索順序**:
```
1. --config オプションで明示的に指定されたパス
2. 環境変数 SEARCH_DOCS_CONFIG
3. カレントディレクトリから親を遡って .search-docs.json を探す
   - process.cwd()/.search-docs.json
   - process.cwd()/../.search-docs.json
   - ... (ルートディレクトリまたは見つかるまで)
4. 見つからなければデフォルト設定で動作
```

**Server/MCP Serverの探索順序**:
```
1. --config オプションで明示的に指定されたパス
2. 環境変数 SEARCH_DOCS_CONFIG
3. カレントディレクトリの .search-docs.json のみ
   - （親は遡らない - プロジェクトルートで起動される想定）
4. 見つからなければデフォルト設定で動作
```

**実装**:
```typescript
// packages/cli/src/utils/config-resolver.ts
export async function findConfigFile(
  startDir: string = process.cwd(),
  traverseUp: boolean = true
): Promise<string | null> {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (true) {
    const configPath = path.join(currentDir, '.search-docs.json');

    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // ファイルが存在しない
    }

    if (!traverseUp || currentDir === root) {
      return null;
    }

    currentDir = path.dirname(currentDir);
  }
}
```

**理由**:
1. **CLI**: サブディレクトリからの実行を考慮（開発者の利便性）
2. **Server/MCP**: プロジェクトルートでの実行を想定（一貫性重視）
3. Git等のツールと同様の探索パターン

### 影響

**ポジティブ**:
- 複数プロジェクトでの異なるポート使用が可能に
- サブディレクトリからのコマンド実行が可能に
- バックグラウンド起動がデフォルトでユーザビリティ向上
- 環境変数サポートでCI/CD対応

**ネガティブ**:
- `--daemon` オプションが廃止（破壊的変更）
  - 対処: v1.0.0でのリリースから間もないため、早期に変更を実施
- 設定ファイル探索の複雑性増加（わずか）

**移行ガイド**:
```bash
# v1.0.0
search-docs server start --daemon

# v1.0.1以降
search-docs server start  # デフォルトでバックグラウンド
```

### 実装状況

**Task 10 (v1.0.1)**:
- ✅ `resolveServerUrl()` ユーティリティ実装
- ✅ CLIコマンド（search, index等）にポート設定適用
- ✅ MCP Serverサーバ自動起動機能

**Task 11 (v1.0.2)**:
- ✅ サーバ起動デフォルト変更（`--daemon` → `--foreground`）
- ✅ グローバル --config オプション実装
- ✅ 設定ファイル自動探索機能
- ✅ 環境変数 SEARCH_DOCS_CONFIG サポート

### 関連ドキュメント

- 実装計画: `prompts/tasks/task10.port-config-and-auto-start.v1.md`
- 実装計画: `prompts/tasks/task11.cli-improvements.v1.md`
- 調査レポート: `prompts/tasks/research.config-startup.v1.md`

---

## 更新履歴

- 2025-01-27: 初版作成（ADR-001〜010）
- 2025-01-27: ADR-011追加（階層的コンテンツによるベクトル検索精度向上）
- 2025-01-27: ADR-012追加（Section型のフラット構造採用）
- 2025-10-28: ADR-013追加（CLIサーバプロセス管理の実装方針）
- 2025-10-30: ADR-014追加（IndexRequestテーブルによる非同期インデックス管理）
- 2025-10-31: ADR-015追加（CLI設定管理とサーバ起動の改善）
