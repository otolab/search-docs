# Task 14: 検索結果に行番号範囲を表示

**日時**: 2025-10-31
**目的**: 検索結果出力に元文書内の行番号範囲（line: xxx-xxx）を追加する
**規模**: 大きな作業（DBスキーマ変更を含む）

## 要件

検索結果の出力に、以下の情報を追加する：
1. セクションが元文書内のどの行に対応するか（行番号範囲）
2. セクションが文書内で何番目の段落か（段落番号）

### 出力イメージ

**現在**:
```
docs/architecture.md > アーキテクチャ概要
depth: 1
score: 0.85
---
本文内容...
```

**改善後**:
```
docs/architecture.md > アーキテクチャ概要
depth: 1
section: 2 (2番目のH1セクション)
line: 15-42
score: 0.85
---
本文内容...
```

### データ項目

1. **startLine / endLine**: 元文書内の行番号範囲（1-indexed）
2. **sectionNumber**: 同じdepthのセクション内での連番（1-indexed）
   - 例: 文書内の2番目のH1セクション → sectionNumber=2, depth=1

## 設計方針

### 1. データモデルの拡張

#### Section型の拡張

**packages/types/src/section.ts**:
```typescript
export interface Section {
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
  documentHash: string;
  createdAt: Date;
  updatedAt: Date;
  summary?: string;
  documentSummary?: string;

  // 新規追加
  startLine: number;      // セクション開始行（1-indexed）
  endLine: number;        // セクション終了行（1-indexed）
  sectionNumber: number;  // 同じdepthのセクション内での連番（1-indexed）
}
```

#### Python DBスキーマの拡張

**packages/db-engine/src/python/schemas.py**:
```python
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
    ("document_hash", pa.string()),
    ("created_at", pa.timestamp('ms')),
    ("updated_at", pa.timestamp('ms')),
    # 新規追加
    ("start_line", pa.int32()),
    ("end_line", pa.int32()),
    ("section_number", pa.int32()),
])
```

### 2. Markdown分割時の行番号追跡

#### MarkdownSplitterの拡張

**packages/server/src/splitter/markdown-splitter.ts**:

現在の実装では、テキストをパースして構造化するが、行番号情報は保持していない。

**必要な変更**:
1. パース時に各要素の行番号を記録
2. セクション生成時に開始行・終了行を計算
3. Section作成時に行番号を含める

**実装案**:
```typescript
interface ParsedElement {
  type: 'heading' | 'content';
  level?: number;
  text: string;
  startLine: number;  // 新規追加
  endLine: number;    // 新規追加
}

private parseMarkdown(markdown: string): ParsedElement[] {
  const lines = markdown.split('\n');
  const elements: ParsedElement[] = [];
  let currentLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      elements.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
        startLine: i + 1,
        endLine: i + 1,
      });
    } else if (line.trim()) {
      // コンテンツ行の追跡
      // ...
    }
  }

  return elements;
}
```

**課題**:
- 階層的コンテンツ構造（親が子を含む）での行番号計算
- 空行の扱い
- コードブロック、リストなどの複数行要素の処理

### 3. 検索結果出力の拡張

#### CLIの検索結果表示

**packages/cli/src/commands/search.ts**:
```typescript
function formatSearchResult(result: Section): string {
  const pathAndHeading = result.heading
    ? `${result.documentPath} > ${result.heading}`
    : result.documentPath;

  let output = `\n${pathAndHeading}\n`;
  output += `depth: ${result.depth}\n`;

  // 新規追加
  if (result.sectionNumber) {
    const depthLabel = ['document', 'H1', 'H2', 'H3'][result.depth] || `depth-${result.depth}`;
    output += `section: ${result.sectionNumber} (${result.sectionNumber}番目の${depthLabel}セクション)\n`;
  }

  if (result.startLine && result.endLine) {
    output += `line: ${result.startLine}-${result.endLine}\n`;
  }

  output += `score: ${result._score?.toFixed(2) || 'N/A'}\n`;
  // ...
}
```

#### MCP Serverの検索結果

**packages/mcp-server/src/server.ts**:

MCP Serverは構造化されたデータを返すため、フィールドとして追加するだけ：
```typescript
{
  name: "search",
  description: "文書を検索",
  inputSchema: { /* ... */ },
  handler: async (args) => {
    const results = await client.search(args.query, {
      depth: args.depth,
      limit: args.limit,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            results.map(r => ({
              path: r.documentPath,
              heading: r.heading,
              depth: r.depth,
              startLine: r.startLine,  // 新規追加
              endLine: r.endLine,      // 新規追加
              score: r._score,
              content: r.content,
            })),
            null,
            2
          ),
        },
      ],
    };
  },
}
```

### 4. 既存データの移行

#### マイグレーション戦略

既存のインデックスには行番号情報がないため、以下の対応が必要：

**案A: 全インデックス再構築（推奨）**
```bash
search-docs index rebuild
```

**案B: デフォルト値での対応**
- startLine: 0（不明を示す）
- endLine: 0（不明を示す）
- 表示時に `startLine > 0` の場合のみ行番号を表示

**推奨**: 案A（全再構築）
- データの一貫性確保
- 行番号情報の完全性

## 実装フェーズ

### Phase 1: データモデル拡張
1. Section型に `startLine`, `endLine` フィールド追加
2. Python DBスキーマに `start_line`, `end_line` カラム追加
3. TypeScript-Python変換層の更新

### Phase 2: Markdown分割の拡張
1. パーサーの行番号追跡機能実装
2. セクション生成時の行番号計算
3. テストケースの更新

### Phase 3: 検索結果表示の更新
1. CLI出力フォーマットの更新
2. MCP Server応答フォーマットの更新
3. JSON形式出力への対応

### Phase 4: 既存データの移行
1. インデックス再構築の実施
2. ドキュメント更新

## 技術的な課題

### 1. 階層的コンテンツでの行番号

現在の実装では、親セクションは子のコンテンツを再帰的に含む（ADR-011）。

**例**:
```markdown
# H1セクション         ← line 1
本文1                 ← line 2-3

## H2セクション        ← line 5
本文2                 ← line 6-8

### H3セクション       ← line 10
本文3                 ← line 11-15
```

**セクションと行番号の対応**:
- depth=0（文書全体）: line 1-15
- depth=1（H1）: line 1-15（子を含む）
- depth=2（H2）: line 5-15（子を含む）
- depth=3（H3）: line 10-15

**問題**: 親セクションの `endLine` は子の最終行になる

**解決策**: 2つのアプローチを検討
- **案A**: セクション自体の行範囲のみ記録（子を含まない）
- **案B**: 実際のコンテンツ範囲を記録（子を含む）

**推奨**: 案B
- 検索結果に表示される `content` と行番号が一致する
- ユーザーがファイルを開いた時に該当範囲が正確

### 2. パース精度の向上

現在のパーサーは正規表現ベースで単純。

**改善案**:
- Markdown ASTライブラリ（`remark`等）の使用
- 各ノードの位置情報（line, column）を取得
- より正確な行番号追跡

### 3. テストの拡張

行番号追跡機能のテストケース追加：
```typescript
describe('行番号追跡', () => {
  it('単一セクションの行番号を正しく計算', () => {
    const markdown = `# Heading\nContent line 1\nContent line 2`;
    const sections = splitter.split(markdown);
    expect(sections[0].startLine).toBe(1);
    expect(sections[0].endLine).toBe(3);
  });

  it('階層的セクションの行番号を正しく計算', () => {
    // ...
  });
});
```

## 影響範囲

### 破壊的変更

- **DBスキーマ変更**: 既存のインデックスは行番号情報がない
- **対処**: インデックス再構築が必要

### 互換性

- **API互換性**: Section型にフィールド追加（オプショナル扱い可能）
- **後方互換性**: 古いインデックスでも動作（行番号は表示されない）

## 段落番号（sectionNumber）の計算

### 計算方法

MarkdownSplitter内で、同じdepthのセクションごとに連番を割り当てる。

**例**:
```markdown
# Introduction          ← depth=1, sectionNumber=1
## Overview            ← depth=2, sectionNumber=1
## Features            ← depth=2, sectionNumber=2

# Architecture         ← depth=1, sectionNumber=2
## Design              ← depth=2, sectionNumber=3
### Components         ← depth=3, sectionNumber=1

# Conclusion           ← depth=1, sectionNumber=3
```

### 実装案

```typescript
// MarkdownSplitter内
private assignSectionNumbers(sections: Section[]): void {
  const counters = new Map<number, number>(); // depth → counter

  for (const section of sections) {
    const currentCount = counters.get(section.depth) || 0;
    section.sectionNumber = currentCount + 1;
    counters.set(section.depth, currentCount + 1);
  }
}
```

## 完了条件

1. ✅ Section型に `startLine`, `endLine`, `sectionNumber` フィールド追加
2. ✅ DBスキーマに `start_line`, `end_line`, `section_number` カラム追加
3. ✅ MarkdownSplitterで行番号追跡と段落番号計算
4. ✅ CLI出力に行番号範囲と段落番号表示
5. ✅ MCP Server応答に行番号・段落番号情報含む
6. ✅ テストケース追加
7. ✅ インデックス再構築の実施
8. ✅ ドキュメント更新（ユーザーガイド、CLI リファレンス）

---

**作成日時**: 2025-10-31
**ステータス**: 計画中
**推定工数**: 8-12時間
