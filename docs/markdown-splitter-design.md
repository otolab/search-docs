# Markdown分割機能の設計

## 方針

### 基本原則
1. **章立てベースの機械的な分割**: H1-H3の見出しで分割
2. **情報の整理はドキュメント側で完了**: 分割ロジックは複雑にしない
3. **将来的なサマリ追加を前提**: データ構造にサマリフィールドを確保

## データ構造

### Section型の拡張

```typescript
export interface Section {
  id: string;
  documentPath: string;
  heading: string;
  depth: number;
  content: string;
  tokenCount: number;
  vector: number[];
  parentId: string | null;
  order: number;
  isDirty: boolean;
  documentHash: string;
  createdAt: Date;
  updatedAt: Date;

  // サマリフィールド（将来的に追加）
  summary?: string;  // セクションの要約（後で生成）
  documentSummary?: string;  // 文書全体の要約（コンテキスト保持用）
}
```

**設計意図**:
- `summary`: セクション自体の要約（後で生成）
- `documentSummary`: 文書全体の要約をすべてのセクションに付与
  - セクション単体で検索されてもコンテキストを保持
  - 「このセクションはどの文書の一部か」を理解可能

## 分割アルゴリズム

### シンプルな章立てベース分割

```
1. Markdownをパース（markedでAST生成）
2. 見出し（H1-H3）で分割
3. depth 0: 文書全体（前文・見出しのない部分）
4. depth 1: H1セクション
5. depth 2: H2セクション（H1の子）
6. depth 3: H3セクション（H2の子）
```

**トークン数チェック**:
- トークン数が`maxTokensPerSection`を超える場合のみ警告
- 基本的には見出し構造を尊重（強制分割しない）

### 実装例

```typescript
export class MarkdownSplitter {
  constructor(
    private config: IndexingConfig,
    private tokenCounter: TokenCounter
  ) {}

  /**
   * Markdownを分割
   */
  split(content: string, documentPath: string, documentHash: string): Section[] {
    // 1. Markdownをパース
    const tokens = marked.lexer(content);

    // 2. 見出し構造を抽出
    const structure = this.extractHeadingStructure(tokens);

    // 3. セクションに変換
    const sections = this.buildSections(
      structure,
      documentPath,
      documentHash
    );

    return sections;
  }

  /**
   * 見出し構造を抽出
   */
  private extractHeadingStructure(tokens: marked.Token[]): HeadingNode[] {
    const nodes: HeadingNode[] = [];
    let currentDepth0: HeadingNode | null = null;
    let currentDepth1: HeadingNode | null = null;
    let currentDepth2: HeadingNode | null = null;

    for (const token of tokens) {
      if (token.type === 'heading') {
        const depth = token.depth; // 1-6
        const heading = token.text;
        const content: string[] = [];

        if (depth === 1) {
          currentDepth1 = { depth: 1, heading, content, children: [] };
          nodes.push(currentDepth1);
          currentDepth2 = null;
        } else if (depth === 2 && currentDepth1) {
          currentDepth2 = { depth: 2, heading, content, children: [] };
          currentDepth1.children.push(currentDepth2);
        } else if (depth === 3 && currentDepth2) {
          const node = { depth: 3, heading, content, children: [] };
          currentDepth2.children.push(node);
        }
        // H4以降は無視（親セクションに含める）
      } else {
        // コンテンツを現在のノードに追加
        const text = this.tokenToText(token);
        if (currentDepth2) {
          currentDepth2.content.push(text);
        } else if (currentDepth1) {
          currentDepth1.content.push(text);
        } else {
          // 見出しのない前文
          if (!currentDepth0) {
            currentDepth0 = { depth: 0, heading: '', content: [], children: [] };
            nodes.unshift(currentDepth0);
          }
          currentDepth0.content.push(text);
        }
      }
    }

    return nodes;
  }

  /**
   * HeadingNodeをSectionに変換
   */
  private buildSections(
    nodes: HeadingNode[],
    documentPath: string,
    documentHash: string,
    parentId: string | null = null,
    orderStart: number = 0
  ): Section[] {
    const sections: Section[] = [];
    let order = orderStart;

    for (const node of nodes) {
      const id = nanoid();
      const content = this.buildContent(node);
      const tokenCount = this.tokenCounter.count(content);

      // トークン数チェック（警告のみ）
      if (tokenCount > this.config.maxTokensPerSection) {
        console.warn(
          `Section "${node.heading}" exceeds maxTokensPerSection (${tokenCount} > ${this.config.maxTokensPerSection})`
        );
      }

      const section: Omit<Section, 'vector'> = {
        id,
        documentPath,
        heading: node.heading || '(document root)',
        depth: node.depth,
        content,
        tokenCount,
        parentId,
        order: order++,
        isDirty: false,
        documentHash,
        createdAt: new Date(),
        updatedAt: new Date(),

        // サマリフィールド（現時点ではundefined）
        summary: undefined,
        documentSummary: undefined,
      };

      sections.push(section);

      // 子セクションを再帰的に処理
      if (node.children.length > 0) {
        const childSections = this.buildSections(
          node.children,
          documentPath,
          documentHash,
          id,
          0
        );
        sections.push(...childSections);
      }
    }

    return sections;
  }

  /**
   * HeadingNodeからコンテンツテキストを構築
   */
  private buildContent(node: HeadingNode): string {
    let text = '';

    // 見出しを追加
    if (node.heading) {
      const prefix = '#'.repeat(node.depth);
      text += `${prefix} ${node.heading}\n\n`;
    }

    // コンテンツを追加
    text += node.content.join('\n');

    return text.trim();
  }

  /**
   * marked.Tokenをテキストに変換
   */
  private tokenToText(token: marked.Token): string {
    // marked.Rendererを使用してテキスト化
    // または簡易的にJSON.stringify(token)からテキスト抽出
    return marked.parser([token]);
  }
}

interface HeadingNode {
  depth: number;
  heading: string;
  content: string[];
  children: HeadingNode[];
}
```

## トークンカウンター

### シンプルな実装

```typescript
import { encode } from 'gpt-tokenizer';

export class TokenCounter {
  /**
   * テキストのトークン数を計測
   */
  count(text: string): number {
    try {
      const tokens = encode(text);
      return tokens.length;
    } catch (error) {
      // エラー時は文字数の1/4を概算値として使用
      console.warn('Token counting failed, using character count / 4');
      return Math.ceil(text.length / 4);
    }
  }
}
```

**特徴**:
- gpt-tokenizerを使用（tiktoken互換）
- エラー時のフォールバック（文字数÷4）

## サマリ生成の将来的な実装

### フェーズ分け

#### Phase 1: 基本分割（今回実装）
- 章立てベースの機械的な分割
- サマリフィールドは`undefined`

#### Phase 2: サマリ生成（後で実装）
```typescript
export class SummaryGenerator {
  /**
   * 文書全体の要約を生成
   */
  async generateDocumentSummary(content: string): Promise<string> {
    // LLMを使用して文書全体を要約
    // 例: Claude API, OpenAI API
    return summary;
  }

  /**
   * セクションの要約を生成
   */
  async generateSectionSummary(section: Section): Promise<string> {
    // セクションの内容を要約
    return summary;
  }

  /**
   * すべてのセクションにサマリを追加
   */
  async addSummaries(
    sections: Section[],
    documentContent: string
  ): Promise<Section[]> {
    // 1. 文書全体の要約を生成
    const documentSummary = await this.generateDocumentSummary(documentContent);

    // 2. 各セクションの要約を生成
    for (const section of sections) {
      section.summary = await this.generateSectionSummary(section);
      section.documentSummary = documentSummary;
    }

    return sections;
  }
}
```

### サマリの活用方法

#### 検索時の利用
```typescript
// セクション検索時にサマリを表示
const result: SearchResult = {
  id: section.id,
  documentPath: section.documentPath,
  heading: section.heading,
  content: section.content,
  summary: section.summary,  // セクション要約
  documentSummary: section.documentSummary,  // 文書全体の要約
  score: 0.15,
};
```

#### コンテキスト補完
```
検索結果:
---
文書: /docs/api-reference.md
文書要約: このドキュメントはREST APIのリファレンスです...

セクション: POST /users
セクション要約: 新しいユーザーを作成するエンドポイント...

内容:
## POST /users
新しいユーザーを作成します...
```

## データベーススキーマへの反映

### PyArrowスキーマ更新

```python
def get_sections_schema(vector_dimension: int = 256) -> pa.Schema:
    return pa.schema([
        pa.field("id", pa.string()),
        pa.field("document_path", pa.string()),
        pa.field("heading", pa.string()),
        pa.field("depth", pa.int32()),
        pa.field("content", pa.string()),
        pa.field("token_count", pa.int32()),
        pa.field("vector", pa.list_(pa.float32(), vector_dimension)),
        pa.field("parent_id", pa.string()),
        pa.field("order", pa.int32()),
        pa.field("is_dirty", pa.bool_()),
        pa.field("document_hash", pa.string()),
        pa.field("created_at", pa.timestamp('ms')),
        pa.field("updated_at", pa.timestamp('ms')),

        # サマリフィールド（オプショナル）
        pa.field("summary", pa.string()),
        pa.field("document_summary", pa.string()),
    ])
```

## テスト戦略

### 単体テスト

```typescript
describe('MarkdownSplitter', () => {
  it('見出しで分割できる', () => {
    const md = `
# H1 Section
Content for H1

## H2 Section
Content for H2

### H3 Section
Content for H3
    `;

    const sections = splitter.split(md, '/test.md', 'hash123');

    expect(sections).toHaveLength(3);
    expect(sections[0].depth).toBe(1);
    expect(sections[1].depth).toBe(2);
    expect(sections[2].depth).toBe(3);
  });

  it('見出しのない前文を depth 0 として扱う', () => {
    const md = `
前文です。

# H1 Section
    `;

    const sections = splitter.split(md, '/test.md', 'hash123');

    expect(sections[0].depth).toBe(0);
    expect(sections[0].heading).toBe('(document root)');
  });

  it('親子関係を正しく構築する', () => {
    const md = `
# H1
## H2
### H3
    `;

    const sections = splitter.split(md, '/test.md', 'hash123');

    expect(sections[1].parentId).toBe(sections[0].id);
    expect(sections[2].parentId).toBe(sections[1].id);
  });

  it('サマリフィールドは undefined', () => {
    const md = '# Test\nContent';
    const sections = splitter.split(md, '/test.md', 'hash123');

    expect(sections[0].summary).toBeUndefined();
    expect(sections[0].documentSummary).toBeUndefined();
  });
});
```

## まとめ

### 今回実装する機能
- 章立てベースの機械的な分割
- トークン数の計測と警告
- サマリフィールドの確保（undefined）

### 後で実装する機能
- LLMによるサマリ生成
- 文書全体の要約
- セクション要約

### 利点
- **シンプル**: 複雑な分割ロジック不要
- **予測可能**: ドキュメント構造をそのまま反映
- **拡張可能**: サマリ追加が容易

---

**実装優先度**: Phase 2.3で実装
