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

      expect(sections).toHaveLength(1);
      expect(sections[0].depth).toBe(1);
      expect(sections[0].heading).toBe('H1 Section');
      expect(sections[0].content).toContain('# H1 Section');
      expect(sections[0].content).toContain('Content for H1');
    });

    it('H1とH2の階層構造を正しく分割できる', () => {
      const md = `# H1 Section
Content for H1

## H2 Section
Content for H2`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections).toHaveLength(2);
      expect(sections[0].depth).toBe(1);
      expect(sections[0].heading).toBe('H1 Section');
      expect(sections[1].depth).toBe(2);
      expect(sections[1].heading).toBe('H2 Section');
      expect(sections[1].parentId).toBe(sections[0].id);
    });

    it('H1, H2, H3の3階層を正しく分割できる', () => {
      const md = `# H1 Section
Content for H1

## H2 Section
Content for H2

### H3 Section
Content for H3`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections).toHaveLength(3);
      expect(sections[0].depth).toBe(1);
      expect(sections[1].depth).toBe(2);
      expect(sections[2].depth).toBe(3);
      expect(sections[1].parentId).toBe(sections[0].id);
      expect(sections[2].parentId).toBe(sections[1].id);
    });
  });

  describe('見出しのない前文（depth 0）', () => {
    it('見出しのない前文をdepth 0として扱う', () => {
      const md = `前文です。

これは見出しの前にある文章です。

# H1 Section
H1の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections.length).toBeGreaterThanOrEqual(2);
      expect(sections[0].depth).toBe(0);
      expect(sections[0].heading).toBe('(document root)');
      expect(sections[0].content).toContain('前文です');
      expect(sections[0].parentId).toBeNull();
    });

    it('前文がない場合はdepth 0セクションを作らない', () => {
      const md = `# H1 Section
H1の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].depth).toBe(1);
      expect(sections[0].heading).toBe('H1 Section');
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

      expect(sections).toHaveLength(4);

      // First H1とその子
      expect(sections[0].heading).toBe('First H1');
      expect(sections[0].depth).toBe(1);
      expect(sections[1].heading).toBe('H2 under First');
      expect(sections[1].parentId).toBe(sections[0].id);

      // Second H1とその子
      expect(sections[2].heading).toBe('Second H1');
      expect(sections[2].depth).toBe(1);
      expect(sections[2].parentId).toBeNull();
      expect(sections[3].heading).toBe('H2 under Second');
      expect(sections[3].parentId).toBe(sections[2].id);
    });

    it('H1がない場合、H2を直接トップレベルとして扱う', () => {
      const md = `## H2 Section
H2の内容

### H3 Section
H3の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].depth).toBe(2);
      expect(sections[0].heading).toBe('H2 Section');
      expect(sections[0].parentId).toBeNull();
      expect(sections[1].parentId).toBe(sections[0].id);
    });

    it('H4以降の見出しは親セクションに含める', () => {
      const md = `## H2 Section
H2の内容

#### H4 Section
H4の内容

##### H5 Section
H5の内容`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // H4, H5は独立したセクションにならず、H2の内容に含まれる
      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe('H2 Section');
      // H4, H5の内容が含まれている
      expect(sections[0].content).toContain('H2の内容');
      expect(sections[0].content).toContain('H4の内容');
      expect(sections[0].content).toContain('H5の内容');
    });
  });

  describe('順序管理', () => {
    it('セクションの順序が正しく設定される', () => {
      const md = `# H1
## H2-1
### H3-1
## H2-2`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].order).toBe(0); // H1
      expect(sections[1].order).toBe(0); // H2-1 (親の順序として)
      expect(sections[2].order).toBe(0); // H3-1
      expect(sections[3].order).toBe(1); // H2-2
    });
  });

  describe('メタデータとフィールド', () => {
    it('documentPathとdocumentHashが正しく設定される', () => {
      const md = '# Test';
      const sections = splitter.split(md, '/docs/test.md', 'abc123');

      expect(sections[0].documentPath).toBe('/docs/test.md');
      expect(sections[0].metadata.documentHash).toBe('abc123');
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

      expect(sections).toHaveLength(2);
      expect(sections[0].id).toBeTruthy();
      expect(sections[1].id).toBeTruthy();
      expect(sections[0].id).not.toBe(sections[1].id);
    });
  });

  describe('トークン数管理', () => {
    it('トークン数が計測される', () => {
      const md = `# Test
Some content here`;
      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections[0].tokenCount).toBeGreaterThan(0);
    });

    it('maxTokensPerSectionを超えても警告のみ（分割しない）', () => {
      // 非常に長いコンテンツを生成
      const longContent = 'a'.repeat(5000);
      const md = `# Test\\n${longContent}`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // 警告は出るが、セクションは1つのまま（強制分割しない）
      expect(sections).toHaveLength(1);
      expect(sections[0].tokenCount).toBeGreaterThan(config.maxTokensPerSection);
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

      // maxDepth=2なので、H1とH2のみ作成される（H3は作成されない）
      expect(sections).toHaveLength(2);
      expect(sections[0].depth).toBe(1);
      expect(sections[1].depth).toBe(2);
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

      // H3以降は子セクションとして作成されない
      expect(sections).toHaveLength(2); // H1とH2のみ
    });

    it('maxDepth内のdepthプロパティは正しく設定される', () => {
      const md = `# H1
## H2
### H3`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      // デフォルトのmaxDepth=3なので全て作成される
      expect(sections).toHaveLength(3);
      expect(sections[0].depth).toBe(1);
      expect(sections[1].depth).toBe(2);
      expect(sections[2].depth).toBe(3);
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

      expect(sections).toEqual([]);
    });

    it('見出しのみのMarkdownを処理できる', () => {
      const md = '# H1';
      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe('H1');
      expect(sections[0].content).toContain('# H1');
    });

    it('空白のみのコンテンツを適切に処理する', () => {
      const md = `# H1



## H2`;

      const sections = splitter.split(md, '/test.md', 'hash123');

      expect(sections).toHaveLength(2);
    });
  });
});
