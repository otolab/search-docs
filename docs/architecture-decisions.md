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

## ADR-016: LanceDBインデックス戦略と前方一致検索

**日付**: 2025-11-07
**状態**: 採用
**決定者**: 実装チーム
**関連**: task22, LanceDB最適化

### コンテキスト

task21でstatusカラムにBITMAPインデックスを追加し、count_rows()が約40倍高速化（30秒タイムアウト→0.741秒）した成功を受けて、他のカラムへのインデックス戦略を検討する必要があった。

同時に、MCP検索ツールでパス指定による絞り込み機能が不足していた：
- excludePathsは存在したが完全一致のみ
- includePathsパラメータが存在しない
- 「特定ディレクトリ配下のみ検索」ができない

### 検討した選択肢

#### 1. インデックスタイプの選択

**BTREE vs BITMAP**:
- BTREE: 等価検索、範囲検索に有効
- BITMAP: Low-cardinality（ユニーク値が少ない）に最適

**決定**: カーディナリティに基づいて使い分け
- Low-cardinality (< 数千): BITMAP
- Medium/High-cardinality: BTREE

#### 2. 前方一致検索の実装方法

**オプション1: LIKE演算子** (採用):
- `document_path LIKE 'docs/%'`
- DataFusionネイティブサポート
- 統計ベース最適化の活用

**オプション2: 正規表現**:
- より柔軟だが複雑
- パフォーマンスが不明

### 決定

#### Phase 1インデックス実装

**index_requestsテーブル**:
1. status (BITMAP) - 5値、既存（task21）
2. document_path (BTREE) - 等価検索用
3. document_hash (BTREE) - 等価検索用

**sectionsテーブル**:
1. document_path (BTREE) - 等価検索用
2. is_dirty (BITMAP) - 2値（true/false）

**理由**:
1. 高頻度クエリのパフォーマンス向上
2. BTREEは等価検索に確実に有効
3. BITMAPはLow-cardinalityで最適
4. task21での実績（40倍高速化）

#### 前方一致検索の実装

**includePaths**: OR条件
```python
path_conditions = [f"document_path LIKE '{path}%'" for path in include_paths]
filters.append(f"({' OR '.join(path_conditions)})")
```

**excludePaths**: AND条件
```python
for path in exclude_paths:
    filters.append(f"document_path NOT LIKE '{path}%'")
```

**理由**:
1. LIKE演算子はDataFusionでネイティブサポート
2. NOT LIKE 'prefix%'はmin/max統計ベース最適化あり（DataFusion 46.0.0）
3. シンプルで理解しやすい実装
4. 将来のBTREE効果検証に備える

### 影響

**ポジティブ**:
- 等価検索のパフォーマンス向上（特にcount_rows）
- パス指定による柔軟な検索が可能に
- includePaths/excludePathsの組み合わせ使用
- MCP統合完了

**ネガティブ**:
- LIKE 'prefix%'クエリのBTREE効果は未検証
- インデックス維持コスト（ストレージ、書き込み速度）

**トレードオフ**:
- ストレージ使用量の増加 vs クエリパフォーマンス向上
- 書き込み速度の若干低下 vs 検索速度の大幅向上

### 実装詳細

**wait_for_index() API**:
```python
table.wait_for_index(["column_name_idx"], timeout=timedelta(seconds=60))
```

**インデックス命名**: `{column_name}_idx`

**バグ修正**: SearchDocsServer.search()のexcludePaths処理
```typescript
const mergedExcludePaths = [
  ...(request.options?.excludePaths || []),
  ...(autoExcludePaths || []),
];
```

### 検証結果

**テスト実施日**: 2025-11-07

1. includePaths: ["docs/"] → docs/配下のみ検索 ✅
2. excludePaths: ["docs/"] → docs/配下を除外 ✅
3. 複合条件: includePaths: ["prompts/"], excludePaths: ["prompts/tasks/"] ✅

**パフォーマンス**: 未測定（将来のタスク）

### 今後の検討事項

1. **LIKE 'prefix%'のパフォーマンス測定**
   - BTREEインデックスの効果検証
   - 大規模データでのベンチマーク

2. **Phase 2インデックス**
   - sections.depth (BTREE or BITMAP)
   - 使用状況に応じて判断

3. **複合インデックス**
   - 現状は不要だが、将来的に検討

### 関連ドキュメント

- 戦略文書: `prompts/tasks/task22.index-strategy.v1.md`
- 実装: `packages/db-engine/src/python/worker.py`
- DataFusion 46.0.0: NOT LIKE prefix optimization

---

## 更新履歴

- 2025-01-27: 初版作成（ADR-001〜010）
- 2025-01-27: ADR-011追加（階層的コンテンツによるベクトル検索精度向上）
- 2025-01-27: ADR-012追加（Section型のフラット構造採用）
- 2025-10-28: ADR-013追加（CLIサーバプロセス管理の実装方針）
- 2025-10-30: ADR-014追加（IndexRequestテーブルによる非同期インデックス管理）
- 2025-10-31: ADR-015追加（CLI設定管理とサーバ起動の改善）
- 2025-11-07: ADR-016追加（LanceDBインデックス戦略と前方一致検索）
- 2026-01-15: ADR-017追加（@parcel/watcherによるファイル監視）
- 2026-05-07: ADR-018追加（CoreML GPU最適化のための静的形状オーバーライド）
- 2026-05-07: ADR-019追加（files.sources リネームとツリーウォーク監視）

---

## ADR-017: @parcel/watcherによるファイル監視

**日付**: 2026-01-15
**状態**: 採用
**決定者**: 実装チーム

### コンテキスト

Markdownファイルの変更を検出し、自動的にインデックスを更新する機能が必要。以下の要件がある：

- ファイルの追加・変更・削除を検出
- 大規模プロジェクト（10万ファイル以上）でも動作
- 除外パターン（node_modules、.gitなど）のサポート
- クロスプラットフォーム対応（Windows/macOS/Linux）
- メモリ・CPU効率が良い

### 検討した選択肢

#### 1. chokidar

Node.jsファイル監視のデファクトスタンダード。

**短所**:
- JavaScriptスレッドでイベント処理（大規模プロジェクトでボトルネック）
- 10万ファイル規模で1GB RAM + 50% CPU消費
- rootDir全体を監視する必要があり、EMFILE（too many open files）リスク
- 却下

#### 2. Watchman直接利用

Facebook製の高性能ファイル監視デーモン。

**短所**:
- 別途デーモンのインストールが必須
- ユーザー環境への依存が増える
- search-docsの「簡単セットアップ」方針に反する
- 却下

#### 3. @parcel/watcher（採用）

**長所**:
- **ネイティブC++実装**: イベントスロットリングをネイティブスレッドで実行
- **大規模プロジェクトに強い**: 10万ファイルでもメモリ・CPU効率的
- **Watchman連携（オプション）**: システムにWatchmanがあれば自動利用（必須ではない）
- **プリビルドバイナリ**: 13種類のプラットフォーム対応、ビルド不要
- **実績**: Parcel, Nuxt.js, Viteで採用済み

**短所**:
- ネイティブモジュールのためプラットフォーム依存あり（プリビルドバイナリで軽減）

### 決定

**@parcel/watcher@^2.5.1を採用**

**理由**:

1. **大規模プロジェクト対応**
   - ネイティブC++実装により、10万ファイル規模でも効率的
   - メモリ・CPU使用量が少ない

2. **Node.jsへの負荷が低い**
   - イベントスロットリングをネイティブスレッドで実行
   - 大量ファイル変更（npm install, git checkout）への耐性

3. **簡単なセットアップ**
   - プリビルドバイナリで追加の依存なし
   - 通常はビルド不要

### 実装の詳細

**依存関係**: `@parcel/watcher@^2.5.1`

**実装ファイル**: `packages/server/src/discovery/file-watcher.ts`

**主な機能**:
- イベント検出: ファイルの追加・変更・削除
- ignoreパターンによる除外フィルタリング
- includeパターンによる対象絞り込み（minimatch使用）
- デバウンス機能（デフォルト300ms）

### トレードオフ

**利点**:
- 大規模プロジェクトでの安定性
- パフォーマンス向上
- メモリ使用量削減

**欠点**:
- chokidarより採用実績が少ない（リスクは低い）
- ネイティブモジュールのため、プラットフォーム依存あり（プリビルドバイナリで軽減）

### 今後の検討事項

1. **Watchmanの推奨**
   - ドキュメントにWatchmanインストールのメリットを記載
   - ただし必須とはしない

2. **パフォーマンスモニタリング**
   - 大規模プロジェクトでの実際のメモリ使用量・CPU使用率の測定
   - 必要に応じてログ追加

### 参考資料

- 実装ファイル: `packages/server/src/discovery/file-watcher.ts`
- Nuxt.jsでの採用: `experimental: { watcher: 'parcel' }`

---

## ADR-018: CoreML GPU最適化のための静的形状オーバーライド

**日付**: 2026-04-27
**状態**: 採用
**決定者**: 実装チーム
**関連PR**: #80

### コンテキスト

PyTorch → ONNX Runtime 移行（task38）後、Apple Silicon環境でGPU利用率が0%にデグレードした。
CoreML Execution Providerに599ノードが委譲されるが、`ProfileComputePlan`で確認すると
全て`MLCPUComputeDevice`にフォールバックしていた。

調査の結果、ONNXモデルの入力が動的形状（`batch_size`, `sequence_length`）で宣言されて
いるため、CoreMLがGPU用の静的コンパイルを実行できないことが判明。

### 問題

**ONNXモデルの動的形状宣言**:
```python
inputs:
  - name: input_ids
    type: tensor(int64)
    shape: [batch_size, sequence_length]  # 両方とも動的
  - name: attention_mask
    type: tensor(int64)
    shape: [batch_size, sequence_length]  # 両方とも動的
```

**CoreMLの制約**:
- CoreMLは静的な計算グラフをコンパイルしてGPU最適化コードを生成する
- 動的形状の場合、コンパイル時に最適化できずCPU実行にフォールバック
- GPU利用率0%、Embedding生成が遅延

### 検討した選択肢

#### 1. 動的形状のまま運用（採用しない）
**長所**: コード変更不要、どんな入力長でも対応
**短所**: Apple Silicon GPU が利用できず性能劣化

#### 2. 単一の固定長セッション（採用しない）
**長所**: 実装が単純
**短所**: 短いクエリでもmax_lengthまでパディング → 無駄な計算。長いテキストは打ち切り → 情報損失

#### 3. バケットサイズ別のセッション分離（採用）
**長所**: 入力長に応じて最適なセッションを選択し、各セッションで静的形状のGPU最適化が効く
**短所**: 複数セッションの管理コスト、メモリフットプリント増加（各バケットのコンパイル済みモデル保持）

### 決定

`SessionOptions.add_free_dimension_override_by_name()` を使用し、セッション作成時に
固定長を指定。3つのバケットサイズ `[64, 2048, 8192]` でセッションを分け、入力長に
応じて選択する。

**バケットサイズの根拠**:
- **64**: 短いクエリ（典型的な検索クエリ、10-30トークン）
- **2048**: 中規模テキスト（段落、セクション単位）
- **8192**: 長文テキスト（文書全体、最大長）

**CoreML プロバイダオプション**:
```python
{
    'ModelFormat': 'MLProgram',                      # GPU対応の新形式（NeuralNetworkは非推奨）
    'MLComputeUnits': 'ALL',                         # GPU/ANE/CPU全て許可
    'AllowLowPrecisionAccumulationOnGPU': '1',      # FP16アキュムレーション高速化
    'RequireStaticInputShapes': '1',                 # 静的ノードのみCoreMLに渡す
    'SpecializationStrategy': 'FastPrediction',      # 推論レイテンシ優先
}
```

### 実装

**変更ファイル**: `packages/db-engine/src/python/embedding_onnx.py`

**CoreMLバケットセッション作成**:
```python
BUCKET_SIZES = [64, 2048, 8192]

for size in BUCKET_SIZES:
    so = ort.SessionOptions()
    so.add_free_dimension_override_by_name('batch_size', 1)
    so.add_free_dimension_override_by_name('sequence_length', size)
    self.sessions[size] = ort.InferenceSession(
        onnx_path, sess_options=so, providers=providers
    )
```

**セッション選択ロジック**:
```python
def _select_bucket(self, token_length: int) -> int:
    for size in BUCKET_SIZES:
        if token_length <= size:
            return size
    return BUCKET_SIZES[-1]
```

**プロバイダ選択の分岐**:
```
CoreMLExecutionProvider あり → バケット別セッション（GPU最適化）
CUDAExecutionProvider あり   → 単一動的セッション（CUDA）
それ以外                      → 単一動的セッション（CPU）
```

### 検証結果

**ProfileComputePlan**（ONNX Runtime診断機能）:
- 修正前: 599/599ノードが `MLCPUComputeDevice`
- **修正後**: 599/599ノードが `MLGPUComputeDevice: Apple M4 Max` ✅

**エンコード動作テスト**:
- 短いクエリ（10-30トークン）: 正常、256次元ベクトル出力
- 中テキスト（500-1000トークン）: 正常
- バッチ処理（複数文書）: 正常
- 既存テスト: 41件全パス

### 影響

**プラットフォーム別動作**:

| プラットフォーム | Execution Provider | セッション戦略 |
|-----------------|-------------------|--------------|
| Apple Silicon（ローカル） | CoreML | バケット別セッション |
| Docker（Linux） | CUDA / CPU | 単一動的セッション |
| その他 | CPU | 単一動的セッション |

**メモリ影響**:
- CoreML環境: 各バケットでコンパイル済みモデル保持（数十MB増）
- 他の環境: 影響なし

### トレードオフ

**利点**:
- Apple Silicon GPUのフル活用が可能に
- バケット選択により無駄なパディング計算を最小化
- CUDA/CPU環境に影響なし

**欠点**:
- CoreML環境で3セッション分のメモリ消費
- バケットセッションではバッチ処理不可（1テキストずつ処理）
- バケットサイズは固定値（将来的に調整が必要になる可能性）

### 参考資料

- [ONNX Runtime CoreML Execution Provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [SessionOptions.add_free_dimension_override_by_name](https://onnxruntime.ai/docs/api/python/api_summary.html#sessionoptions)
- task38: Embedding ONNX化 + Ollama API互換（`prompts/tasks/task38.onnx-migration-ollama-api.v1.md`）

---

## ADR-019: files.sources リネームとツリーウォーク監視

**日付**: 2026-05-07
**状態**: 採用
**決定者**: 実装チーム
**関連**: Issue #99, PR #100

### コンテキスト

Issue #97で`files.include`パターンのスコープ最適化を検討した際、以下の課題が明らかになった：

1. **意味的な問題**: `include`という名称は「どのファイルをインデックス化するか」を定義するが、ファイルウォッチャーの監視対象は「どのディレクトリをウォッチするか」も含むため、意味が曖昧。
2. **パフォーマンス問題**: `docs/**/*.md`のような深い再帰パターンと、`*.md`のような直下のみのパターンが同じ扱いで、無駄な監視が発生。
3. **glob展開の必要性**: `systems/*/docs/**`のような中間globパターンを、ファイルウォッチャーが正しく扱えない。

### 検討した選択肢

#### 1. include のまま最適化を実装（採用しない）

**内容**: `include`という名称を維持しつつ、内部実装でパターン解析とツリーウォークを実装。

**短所**:
- `include`という名称は「包含条件」を連想させ、「監視対象ソース」という意味が伝わりにくい
- 設定ファイルの意図が不明確

#### 2. sources にリネーム + ツリーウォーク（採用）

**内容**:
- `files.include` → `files.sources` にリネーム
- `sources`は「監視対象のソースパターン」という明確な意味
- パターンの `**` 有無で shallow/deep 監視を自動判定するツリーウォーク方式を導入
- 後方互換として `include` を `sources` にマッピング

**長所**:
- 設定ファイルの意図が明確（「どのソースを監視するか」）
- パターン解析により無駄な監視を削減
- glob中間パターンを実ディレクトリに展開
- 後方互換により既存プロジェクトが壊れない

### 決定

`files.include` → `files.sources` にリネームし、ツリーウォークベースのshallow/deep監視を実装。

**理由**:
1. **意味の明確化**: `sources`は「監視対象のソース」という明確な意味
2. **パフォーマンス向上**: shallow/deep分離により無駄な監視を削減
3. **柔軟性**: glob中間パターンを実ディレクトリに展開
4. **後方互換**: 既存の`include`も動作維持

### 実装内容

#### 1. sources リネーム

**変更ファイル**:
- `packages/types/src/config.ts`: `FilesConfig.include` → `FilesConfig.sources`
- `packages/types/src/config/loader.ts`: 後方互換マッピング
- `packages/types/src/config/validator.ts`: `sources` + `include` 両方バリデーション

**後方互換マッピング**:
```typescript
if (config.files?.include && !config.files.sources) {
  config.files.sources = config.files.include;
}
```

#### 2. ツリーウォーク方式の3層構造

```
Layer 0: ツリーウォーク（buildWatchTargets）
  パターン解析 + ディレクトリ走査で deep/shallow subscription を決定。
  shallow root には全サブディレクトリを ignore に追加。

Layer 1: @parcel/watcher subscription
  deep root: 再帰監視（COMMON_IGNORES + exclude のみ）
  shallow root: 直下ファイルのみ（全サブディレクトリを ignore）

Layer 2: shouldProcessFile（精密フィルタ）
  sources パターンの minimatch + .md 拡張子チェック。
```

**実装ファイル**:
- `packages/server/src/discovery/watch-targets.ts`:
  - `analyzePattern()`: パターン解析（deep/shallow判定）
  - `buildWatchTargets()`: WatchTarget構築（ツリーウォーク）
  - `COMMON_IGNORES`: 共通除外パターン
- `packages/server/src/discovery/file-watcher.ts`: 複数subscription対応

#### 3. shallow/deep 判定ルール

| パターン | 判定 | 意味 |
|---------|------|------|
| `docs/**` | deep | docs/ 以下を再帰的に監視 |
| `docs/**/*.md` | deep | 同上 |
| `*.md` | shallow | ルート直下のみ |
| `docs/*` | shallow | docs/ 直下のみ |
| `README.md` | shallow | ルート直下の特定ファイル |

#### 4. glob プレフィックス解決

`systems/*/docs/**` のように中間に glob を含むパターンは、ディレクトリ走査で実パスを解決:

```
systems/ → app-a/docs/ → deep
        → app-b/docs/ → deep
```

### 影響

**ポジティブ**:
- 設定ファイルの意図が明確になる
- shallow/deep分離により監視対象が最適化
- glob中間パターンに対応
- 後方互換により既存プロジェクトが壊れない

**ネガティブ**:
- 設定ファイルの書き方が変わる（ただし後方互換あり）
- ツリーウォークのディスクI/Oコスト（起動時のみ）

**トレードオフ**:
- 設定ファイルの変更（新規推奨: `sources`） vs 意味の明確化
- ツリーウォークのI/O vs 無駄な監視の削減

### テスト

**テストファイル**: `packages/server/src/discovery/__tests__/watch-targets.test.ts`

**テストケース**:
- ✅ パターン解析（analyzePattern）: deep/shallow判定、globプレフィックス抽出、特殊ケースを網羅
- ✅ WatchTargets構築（buildWatchTargets）: deep/shallow分離、glob展開、複合パターン、除外処理、重複排除を網羅

### 関連ドキュメント

- 詳細設計: `docs/file-watcher-design.md`
- 実装: `packages/server/src/discovery/watch-targets.ts`
- 関連Issue: #99
- 関連PR: #100

## ADR-020: LanceDB最適化処理（optimize/cleanup）の安全な運用

### ステータス

承認済み（2026-05-29）

### コンテキスト

ホスト側とDockerコンテナの両方でsearch-docsを動かす環境で、LanceDBのBITMAPインデックスファイルが見つからないエラーが発生した。

```
LanceError(IO): Object at location .../index_requests.lance/_indices/<uuid>/bitmap_page_lookup.lance not found
```

原因は `_maybe_optimize()` で使用していた `cleanup_older_than=timedelta(days=0)` にあった。

### `table.optimize()` の動作

`optimize()` は3つの操作を一括実行する:

1. **Compaction**: 小さいデータファイルを大きなファイルにマージ
2. **Index最適化**: スカラーインデックス（BTREE/BITMAP）の増分更新
3. **Prune**: `cleanup_older_than` より古いバージョンのファイル（データ + インデックス）を物理削除

`cleanup_older_than=timedelta(days=0)` は最新バージョン以外の全ファイルを即座に削除する。

### `compact_files()` と `cleanup_old_versions()` の違い

| 操作 | ファイルマージ | 古いファイル削除 | ディスク使用量 |
|------|-------------|----------------|-------------|
| `compact_files()` | する | しない | 一時的に増加 |
| `cleanup_old_versions(older_than)` | しない | する | 減少 |
| `optimize(cleanup_older_than)` | 両方 | 両方 | 増減あり |

### 問題のメカニズム

LanceDBはMVCC（Multi-Version Concurrency Control）を使用しており、各書き込みで新しいバージョンを作成する。リーダーは `read_consistency_interval` ごとに最新バージョンに追従する。

```
Writer: optimize(cleanup_older_than=0)
  → 古いバージョンのインデックスファイルを即座に削除
  → bitmap_page_lookup.lance 消滅

Reader: read_consistency_interval=5s（まだ古いバージョンを参照中）
  → findIndexRequests()
  → bitmap_page_lookup.lance → File not found!
```

現場では index_requests テーブルの `_indices/` 配下に504個の空UUIDディレクトリが残存していた（ファイルだけ削除され、ディレクトリが残った痕跡）。

### 決定

**`cleanup_older_than` を `timedelta(minutes=10)` に変更する。**

```python
CLEANUP_OLDER_THAN = timedelta(minutes=10)

def _maybe_optimize(self, table, table_name: str) -> None:
    ...
    table.optimize(cleanup_older_than=self.CLEANUP_OLDER_THAN)
```

### 根拠

- LanceDB公式の最小推奨値は10分（[GitHub Discussion #5036](https://github.com/lance-format/lance/discussions/5036)）
- `cleanup_older_than=0` は進行中のトランザクション参照ファイルも削除する（[GitHub Issue #2470](https://github.com/lancedb/lancedb/issues/2470)）
- 安全な値の計算式: `read_consistency_interval × 2 + 典型的な書き込み時間` 以上
- search-docsでは: `5s × 2 + embedding処理時間（数秒〜数十秒）` → 10分は十分な猶予

### search-docsでの最適化処理の全体像

| 処理 | 間隔 | 対象テーブル | 目的 |
|------|------|------------|------|
| `_maybe_optimize()` | sections / index_requests は20回、writer_heartbeat は30回書き込みごと | 全テーブル | compaction + index最適化 + prune |
| `compact_files()` | 100回add_sectionsごと | sections | 断片化防止 |

### 結果

**ポジティブ**:
- マルチプロセス環境でのインデックス破損を防止
- 古いバージョンのファイルは10分後に安全に削除される
- ディスク使用量は一時的に増加するが、10分以内に回収される

**ネガティブ**:
- ディスク使用量が `timedelta(days=0)` 時と比較してわずかに増加（10分分のバージョン）

### 参考情報

- LanceDB Versioning: https://docs.lancedb.com/tables/versioning
- LanceDB Consistency: https://lancedb.com/docs/tables/consistency/
- 関連ADR: ADR-016（LanceDBインデックス戦略）
- 関連タスク: task27（optimize()呼び出し頻度の適正化）、task46（本調査）
