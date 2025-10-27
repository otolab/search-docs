import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownSplitter } from '../markdown-splitter.js';
import type { IndexingConfig } from '@search-docs/types';

describe('MarkdownSplitter', () => {
  let splitter: MarkdownSplitter;
  let config: IndexingConfig;

  beforeEach(() => {
    config = {
      maxTokensPerSection: 500,
      minTokensForSplit: 50,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'ruri-v3-30m',
    };
    splitter = new MarkdownSplitter(config);
  });

  describe('基本的な分割', () => {
    it('H1見出しで分割できる', () => {
      const md = `# H1 Section
Content for H1`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 (文書全体) + depth=1 (H1)
      expect(sections).toHaveLength(2);
      expect(sections[0].depth).toBe(0); // 文書ルート
      expect(sections[0].heading).toBe('(document root)');
      expect(sections[0].content).toContain('# H1 Section'); // 子のコンテンツを含む
      expect(sections[0].content).toContain('Content for H1');
      expect(sections[1].depth).toBe(1);
      expect(sections[1].heading).toBe('H1 Section');
      expect(sections[1].content).toContain('# H1 Section');
      expect(sections[1].content).toContain('Content for H1');
    });

    it('H1とH2の階層構造を正しく分割できる', () => {
      const md = `# H1 Section
Content for H1

## H2 Section
Content for H2`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 (文書全体) + depth=1 (H1) + depth=2 (H2)
      expect(sections).toHaveLength(3);
      expect(sections[0].depth).toBe(0); // 文書ルート
      expect(sections[1].depth).toBe(1);
      expect(sections[1].heading).toBe('H1 Section');
      // H1のコンテンツにはH2の内容も含まれる（階層的コンテンツ）
      expect(sections[1].content).toContain('Content for H1');
      expect(sections[1].content).toContain('## H2 Section');
      expect(sections[1].content).toContain('Content for H2');
      expect(sections[2].depth).toBe(2);
      expect(sections[2].heading).toBe('H2 Section');
      expect(sections[2].parentId).toBe(sections[1].id);
    });

    it('H1, H2, H3の3階層を正しく分割できる', () => {
      const md = `# H1 Section
Content for H1

## H2 Section
Content for H2

### H3 Section
Content for H3`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + depth=1 + depth=2 + depth=3
      expect(sections).toHaveLength(4);
      expect(sections[0].depth).toBe(0); // 文書ルート
      expect(sections[1].depth).toBe(1);
      expect(sections[2].depth).toBe(2);
      expect(sections[3].depth).toBe(3);
      expect(sections[2].parentId).toBe(sections[1].id);
      expect(sections[3].parentId).toBe(sections[2].id);

      // 階層的コンテンツの確認
      expect(sections[1].content).toContain('Content for H1');
      expect(sections[1].content).toContain('Content for H2');
      expect(sections[1].content).toContain('Content for H3');
      expect(sections[2].content).toContain('Content for H2');
      expect(sections[2].content).toContain('Content for H3');
      expect(sections[3].content).toContain('Content for H3');
    });
  });

  describe('見出しのない前文（depth 0）', () => {
    it('見出しのない前文をdepth 0として扱う', () => {
      const md = `前文です。

これは見出しの前にある文章です。

# H1 Section
H1の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + depth=1
      expect(sections).toHaveLength(2);
      expect(sections[0].depth).toBe(0);
      expect(sections[0].heading).toBe('(document root)');
      expect(sections[0].content).toContain('前文です');
      expect(sections[0].content).toContain('# H1 Section'); // 子のコンテンツも含む
      expect(sections[0].content).toContain('H1の内容');
      expect(sections[0].parentId).toBeNull();
    });

    it('前文がない場合もdepth 0セクションは作成される（文書全体を表す）', () => {
      const md = `# H1 Section
H1の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 (文書全体) + depth=1
      expect(sections).toHaveLength(2);
      expect(sections[0].depth).toBe(0);
      expect(sections[0].heading).toBe('(document root)');
      expect(sections[0].content).toContain('# H1 Section');
      expect(sections[0].content).toContain('H1の内容');
      expect(sections[1].depth).toBe(1);
      expect(sections[1].heading).toBe('H1 Section');
    });
  });

  describe('複雑な構造', () => {
    it('複数のH1セクションを正しく分割できる', () => {
      const md = `# First H1
Content 1

## H2 under First
Content 2

# Second H1
Content 3

## H2 under Second
Content 4`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + 2つのH1 + 2つのH2 = 5
      expect(sections).toHaveLength(5);

      expect(sections[0].depth).toBe(0); // 文書ルート

      // First H1とその子
      expect(sections[1].heading).toBe('First H1');
      expect(sections[1].depth).toBe(1);
      expect(sections[1].parentId).toBe(sections[0].id); // depth=0の子
      expect(sections[2].heading).toBe('H2 under First');
      expect(sections[2].parentId).toBe(sections[1].id);

      // Second H1とその子
      expect(sections[3].heading).toBe('Second H1');
      expect(sections[3].depth).toBe(1);
      expect(sections[3].parentId).toBe(sections[0].id); // depth=0の子
      expect(sections[4].heading).toBe('H2 under Second');
      expect(sections[4].parentId).toBe(sections[3].id);
    });

    it('H1がない場合、H2を直接トップレベルとして扱う', () => {
      const md = `## H2 Section
H2の内容

### H3 Section
H3の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + depth=2 + depth=3
      expect(sections).toHaveLength(3);
      expect(sections[0].depth).toBe(0); // 文書ルート
      expect(sections[1].depth).toBe(2);
      expect(sections[1].heading).toBe('H2 Section');
      expect(sections[1].parentId).toBe(sections[0].id); // depth=0の子
      expect(sections[2].parentId).toBe(sections[1].id);
    });

    it('H4以降の見出しは親セクションに含める', () => {
      const md = `## H2 Section
H2の内容

#### H4 Section
H4の内容

##### H5 Section
H5の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + depth=2 のみ（H4, H5は独立したセクションにならない）
      expect(sections).toHaveLength(2);
      expect(sections[0].depth).toBe(0); // 文書ルート
      expect(sections[1].heading).toBe('H2 Section');
      // H4, H5の内容が含まれている（見出しテキストと内容）
      expect(sections[1].content).toContain('H2の内容');
      expect(sections[1].content).toContain('H4の内容');
      expect(sections[1].content).toContain('H5の内容');
      // Note: markedがH4/H5をHTML化する可能性があるため、見出し文字列のチェックは行わない
    });
  });

  describe('順序管理', () => {
    it('セクションの順序が正しく設定される', () => {
      const md = `# H1
## H2-1
### H3-1
## H2-2`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + H1 + H2-1 + H3-1 + H2-2
      expect(sections).toHaveLength(5);
      expect(sections[0].order).toBe(0); // depth=0
      expect(sections[1].order).toBe(0); // H1
      expect(sections[2].order).toBe(0); // H2-1 (H1の最初の子)
      expect(sections[3].order).toBe(0); // H3-1 (H2-1の最初の子)
      expect(sections[4].order).toBe(1); // H2-2 (H1の2番目の子)
    });
  });

  describe('メタデータとフィールド', () => {
    it('documentPathとdocumentHashが正しく設定される', () => {
      const md = '# Test';
      const sections = splitter.split(md, '/docs/test.md', 'abc123');

      // すべてのセクションで確認
      expect(sections[0].documentPath).toBe('/docs/test.md');
      expect(sections[0].metadata.documentHash).toBe('abc123');
      expect(sections[1].documentPath).toBe('/docs/test.md');
      expect(sections[1].metadata.documentHash).toBe('abc123');
    });

    it('サマリフィールドはundefined', () => {
      const md = `# Test
Content`;
      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].metadata.summary).toBeUndefined();
      expect(sections[0].metadata.documentSummary).toBeUndefined();
    });

    it('作成日時と更新日時が設定される', () => {
      const md = '# Test';
      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].metadata.createdAt).toBeInstanceOf(Date);
      expect(sections[0].metadata.updatedAt).toBeInstanceOf(Date);
    });

    it('isDirtyフラグはfalse', () => {
      const md = '# Test';
      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].isDirty).toBe(false);
    });

    it('ユニークなIDが生成される', () => {
      const md = `# H1

## H2`;
      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + H1 + H2 = 3
      expect(sections).toHaveLength(3);
      expect(sections[0].id).toBeTruthy();
      expect(sections[1].id).toBeTruthy();
      expect(sections[2].id).toBeTruthy();
      expect(sections[0].id).not.toBe(sections[1].id);
      expect(sections[1].id).not.toBe(sections[2].id);
    });
  });

  describe('トークン数管理', () => {
    it('トークン数が計測される', () => {
      const md = `# Test
Some content here`;
      const sections = splitter.split(md, '/test.md', 'hash123');

      // すべてのセクションでトークン数が計測される
      expect(sections[0].tokenCount).toBeGreaterThan(0);
      expect(sections[1].tokenCount).toBeGreaterThan(0);
    });

    it('maxTokensPerSectionを超えても警告のみ（分割しない）', () => {
      // 非常に長いコンテンツを生成
      const longContent = 'a'.repeat(5000);
      const md = `# Test\n${longContent}`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + depth=1
      expect(sections).toHaveLength(2);
      // depth=0はH1のコンテンツを含むため、さらに大きくなる
      expect(sections[0].tokenCount).toBeGreaterThan(config.maxTokensPerSection);
      expect(sections[1].tokenCount).toBeGreaterThan(config.maxTokensPerSection);
    });
  });

  describe('maxDepth制限', () => {
    it('maxDepthを超える子セクションは作成されない', () => {
      const md = `# H1
## H2
### H3`;

      const configWithMaxDepth2: IndexingConfig = {
        ...config,
        maxDepth: 2,
      };
      const splitterWithLimit = new MarkdownSplitter(configWithMaxDepth2);
      const sections = splitterWithLimit.split(md, '/test.md', 'hash123');

      // depth=0 + H1 + H2（H3は作成されない）
      expect(sections).toHaveLength(3);
      expect(sections[0].depth).toBe(0); // 文書ルート
      expect(sections[1].depth).toBe(1);
      expect(sections[2].depth).toBe(2);
      // H2のコンテンツにはH3の内容も含まれる（階層的コンテンツ）
      expect(sections[2].content).toContain('H3');
    });

    it('maxDepthを超える深い階層も作成されない', () => {
      const md = `# H1
## H2
### H3
#### H4`;

      const configWithMaxDepth2: IndexingConfig = {
        ...config,
        maxDepth: 2,
      };
      const splitterWithLimit = new MarkdownSplitter(configWithMaxDepth2);
      const sections = splitterWithLimit.split(md, '/test.md', 'hash123');

      // depth=0 + H1 + H2のみ（H3以降は作成されない）
      expect(sections).toHaveLength(3);
    });

    it('maxDepth内のdepthプロパティは正しく設定される', () => {
      const md = `# H1
## H2
### H3`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + H1 + H2 + H3（デフォルトmaxDepth=3）
      expect(sections).toHaveLength(4);
      expect(sections[0].depth).toBe(0);
      expect(sections[1].depth).toBe(1);
      expect(sections[2].depth).toBe(2);
      expect(sections[3].depth).toBe(3);
    });
  });

  describe('Markdownの各種要素', () => {
    it('リストを含むコンテンツを正しく処理できる', () => {
      const md = `# Section
- Item 1
- Item 2
- Item 3`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].content).toContain('Item 1');
      expect(sections[0].content).toContain('Item 2');
    });

    it('コードブロックを含むコンテンツを正しく処理できる', () => {
      const md = `# Section
\`\`\`typescript
const foo = "bar";
\`\`\``;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].content).toContain('const foo');
    });

    it('複数の段落を正しく処理できる', () => {
      const md = `# Section

段落1です。

段落2です。

段落3です。`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].content).toContain('段落1');
      expect(sections[0].content).toContain('段落2');
      expect(sections[0].content).toContain('段落3');
    });
  });

  describe('エッジケース', () => {
    it('空のMarkdownを処理できる', () => {
      const sections = splitter.split('', '/test.md', 'hash123');

      // 空でもdepth=0は作成される
      expect(sections).toHaveLength(1);
      expect(sections[0].depth).toBe(0);
      expect(sections[0].heading).toBe('(document root)');
      expect(sections[0].content).toBe('');
    });

    it('見出しのみのMarkdownを処理できる', () => {
      const md = '# H1';
      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + H1
      expect(sections).toHaveLength(2);
      expect(sections[1].heading).toBe('H1');
      expect(sections[1].content).toContain('# H1');
    });

    it('空白のみのコンテンツを適切に処理する', () => {
      const md = `# H1



## H2`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // depth=0 + H1 + H2
      expect(sections).toHaveLength(3);
    });
  });
});
