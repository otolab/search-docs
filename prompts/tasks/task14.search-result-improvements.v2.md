# Task 14 v2: 検索結果の改善（統合版）

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

**日時**: 2025-10-31（更新）
**目的**: 検索結果の有用性と明瞭性の向上
**統合内容**: Task 14（行番号）+ MCP Server改善 + 新規要件

## 要件まとめ

### 1. 行番号・段落番号の追加（Task 14）
- セクションの元文書内での行番号範囲（`startLine`, `endLine`）
- 同じdepth内での段落番号（`sectionNumber`）

### 2. セクションID活用
- 既存の`Section.id`を使って特定セクションを取得可能に
- `get_document(path, sectionId?)` でセクション単位の取得

### 3. 検索結果プレビューの改善
- **現在**: 固定100文字のsubstring
- **改善後**:
  - 行数指定でプレビュー（デフォルト: 5行）
  - 将来的にはSummaryフィールドがあればそれを優先

### 4. 検索結果の整形方針
- **共通化**: 理想的だがペンディング
- **当面**: CLI/MCP Serverで個別実装
- **重要**: 引用であることを明確にする

### 5. 検索結果の出力フォーマット
**問題**: メタデータと本文が混在し、AIが引用と認識しづらい

**解決策**: 引用を明確にする
```
docs/architecture.md > アーキテクチャ概要
Level: H1 (章)
Section: 2
Line: 15-42
Score: 0.85

Content:
────────────────────────────────────────
# アーキテクチャ概要

本システムは以下の3層構造で...
（5行プレビュー）
────────────────────────────────────────
```

または

```
docs/architecture.md > アーキテクチャ概要
Level: H1 (章) | Section: 2 | Line: 15-42 | Score: 0.85

```markdown
# アーキテクチャ概要

本システムは以下の3層構造で...
（5行プレビュー）
\```
```

## データモデル設計

### Section型の拡張

**packages/types/src/section.ts**:
```typescript
export interface Section {
  // 既存フィールド
  id: string;                 // セクションID（既存、活用）
  documentPath: string;
  heading: string;
  depth: number;
  content: string;
  tokenCount: number;
  vector: Float32Array;
  parentId: string | null;
  order: number;
  isDirty: boolean;
  documentHash: string;
  createdAt: Date;
  updatedAt: Date;
  summary?: string;           // セクションサマリー（将来用）
  documentSummary?: string;

  // 新規追加（Task 14）
  startLine: number;          // セクション開始行（1-indexed）
  endLine: number;            // セクション終了行（1-indexed）
  sectionNumber: number;      // 同じdepthのセクション内での連番（1-indexed）
}
```

### Python DBスキーマの拡張

**packages/db-engine/src/python/schemas.py**:
```python
SectionSchema = pa.schema([
    # 既存フィールド
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
    ("document_hash", pa.string()),
    ("created_at", pa.timestamp('ms')),
    ("updated_at", pa.timestamp('ms')),

    # 新規追加
    ("start_line", pa.int32()),
    ("end_line", pa.int32()),
    ("section_number", pa.int32()),
])
```

## API設計

### 1. get_documentの拡張

**現在**:
```typescript
interface GetDocumentRequest {
  path: string;
}
```

**改善後**:
```typescript
interface GetDocumentRequest {
  path: string;
  sectionId?: string;  // 指定した場合は特定セクションのみ取得
}

interface GetDocumentResponse {
  document: Document;
  section?: Section;   // sectionId指定時のみ
}
```

**動作**:
- `sectionId`なし: 文書全体を返す（現在の動作）
- `sectionId`あり: 指定されたセクションのみを返す

### 2. 検索結果のプレビュー制御

**SearchOptions拡張**:
```typescript
interface SearchOptions {
  depth?: number | number[];
  limit?: number;
  includeCleanOnly?: boolean;

  // 新規追加
  previewLines?: number;      // プレビュー行数（デフォルト: 5）
  useSummary?: boolean;       // Summaryがあればそれを使用（デフォルト: true）
}
```

**サーバ側での処理**:
```typescript
function getPreviewContent(section: Section, previewLines: number = 5): string {
  // 1. Summaryがあればそれを返す
  if (section.summary) {
    return section.summary;
  }

  // 2. 指定行数でプレビュー
  const lines = section.content.split('\n');
  const preview = lines.slice(0, previewLines).join('\n');

  if (lines.length > previewLines) {
    return preview + `\n... (残り${lines.length - previewLines}行)`;
  }

  return preview;
}
```

## 出力フォーマット設計

### CLI出力

**packages/cli/src/utils/output.ts**:
```typescript
function formatSearchResultsAsText(response: SearchResponse, options?: FormatOptions): string {
  const previewLines = options?.previewLines || 5;
  const lines: string[] = [];

  lines.push(`検索結果: ${response.total}件（${response.took}ms）\n`);

  response.results.forEach((result, index) => {
    // ヘッダー行
    const heading = result.heading || '(no heading)';
    lines.push(`${index + 1}. ${result.documentPath} > ${heading}`);

    // メタデータ（1行にまとめる）
    const depthLabel = getDepthLabel(result.depth);
    const meta = [
      `Level: ${depthLabel}`,
      `Section: ${result.sectionNumber}`,
      `Line: ${result.startLine}-${result.endLine}`,
      `Score: ${result.score.toFixed(2)}`,
    ].join(' | ');
    lines.push(meta);

    // コンテンツ（引用として明確に）
    lines.push('\n```markdown');
    const preview = getPreviewContent(result, previewLines);
    lines.push(preview);
    lines.push('```\n');
  });

  return lines.join('\n');
}
```

### MCP Server出力

**packages/mcp-server/src/server.ts**:
```typescript
// searchツールのハンドラ
async (args) => {
  const { query, depth, limit, includeCleanOnly, previewLines = 5 } = args;

  const response = await client.search({
    query,
    options: { depth, limit, includeCleanOnly },
  });

  let resultText = `検索結果: ${response.total}件\n`;
  resultText += `処理時間: ${response.took}ms\n\n`;

  response.results.forEach((result, index) => {
    const heading = result.heading || '(no heading)';
    resultText += `${index + 1}. ${result.documentPath} > ${heading}\n`;

    // メタデータ
    const depthLabel = getDepthLabel(result.depth);
    resultText += `Level: ${depthLabel} | `;
    resultText += `Section: ${result.sectionNumber} | `;
    resultText += `Line: ${result.startLine}-${result.endLine} | `;
    resultText += `Score: ${result.score.toFixed(4)}\n\n`;

    // コンテンツ（引用として明確に）
    resultText += '```markdown\n';
    const preview = getPreviewContent(result, previewLines);
    resultText += preview + '\n';
    resultText += '```\n\n';

    // セクションID（get_documentで取得するため）
    resultText += `(セクションID: ${result.id})\n\n`;
  });

  return {
    content: [{ type: 'text', text: resultText }],
  };
}
```

## 実装フェーズ

### Phase 1: データモデル拡張
- [ ] Section型に `startLine`, `endLine`, `sectionNumber` 追加
- [ ] Python DBスキーマ更新
- [ ] TypeScript-Python変換層更新

### Phase 2: Markdown分割の拡張
- [ ] パーサーに行番号追跡機能追加
- [ ] 段落番号（sectionNumber）計算実装

### Phase 3: API拡張
- [ ] GetDocumentRequest に `sectionId` パラメータ追加
- [ ] SearchOptions に `previewLines` パラメータ追加
- [ ] サーバ側でセクション取得ロジック実装

### Phase 4: 出力フォーマット改善
- [ ] `getPreviewContent()` 実装（行数指定、Summary優先）
- [ ] `getDepthLabel()` 実装（CLIから移植）
- [ ] CLI出力フォーマット更新（引用を明確に）
- [ ] MCP Server出力フォーマット更新（引用を明確に）

### Phase 5: テスト・検証
- [ ] 行番号追跡のテスト
- [ ] セクション取得のテスト
- [ ] プレビュー表示のテスト
- [ ] E2Eテスト

### Phase 6: ドキュメント・リリース
- [ ] インデックス再構築
- [ ] ユーザーガイド更新
- [ ] CHANGELOG更新
- [ ] リリース

## 検索結果の期待値調整

**ドキュメントに追加する説明**:

> ### 検索結果の解釈について
>
> 検索結果のプレビューは、セクションの冒頭部分（デフォルト: 5行）のみを表示します。
> この限られた情報だけで「この資料には価値がない」と判断しないでください。
>
> - **プレビューは導入部**: 本文の核心部分は後続にある可能性があります
> - **全体を確認**: `get_document`でセクションIDを指定して全文を取得できます
> - **文脈を考慮**: 見出しと行番号から、文書内の位置関係を把握できます
>
> より詳細な情報が必要な場合は、セクションIDを使って全文を取得してください。

## 技術的課題

### 1. 行番号追跡の実装方法

remarkパーサーを使用して位置情報を取得：
```typescript
import { remark } from 'remark';
import type { Node } from 'unist';

// remarkの位置情報を利用
const tree = remark().parse(markdown);
visit(tree, 'heading', (node: Node) => {
  const position = node.position;
  const startLine = position.start.line;
  const endLine = position.end.line;
  // ...
});
```

### 2. セクション取得の実装

サーバ側でセクションIDから直接取得：
```typescript
async getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse> {
  if (request.sectionId) {
    // セクションIDで検索
    const section = await this.searchIndex.getSectionById(request.sectionId);
    return {
      document: null, // sectionIdモードでは不要
      section,
    };
  } else {
    // 文書パスで取得（既存の動作）
    const document = await this.documentStorage.get(request.path);
    return { document };
  }
}
```

### 3. プレビュー行数の計算

contentを改行で分割して行数を数える：
```typescript
function getPreviewContent(section: Section, previewLines: number): string {
  if (section.summary) {
    return section.summary;
  }

  const lines = section.content.split('\n');
  if (lines.length <= previewLines) {
    return section.content;
  }

  const preview = lines.slice(0, previewLines).join('\n');
  return `${preview}\n... (残り${lines.length - previewLines}行)`;
}
```

## 完了条件

1. [ ] Section型に `startLine`, `endLine`, `sectionNumber` フィールド追加
2. [ ] DBスキーマ更新
3. [ ] Markdown分割で行番号追跡・段落番号計算
4. [ ] get_documentでセクションID指定取得
5. [ ] 検索結果プレビューの行数指定対応
6. [ ] CLI/MCP Server出力で引用を明確に（```で囲む）
7. [ ] depthのラベル化（"H1 (章)"など）
8. [ ] テストケース追加
9. [ ] ドキュメント更新（期待値調整の説明含む）
10. [ ] インデックス再構築とリリース

---

**作成日時**: 2025-10-31（v2更新）
**ステータス**: 計画中
**推定工数**: 10-14時間
