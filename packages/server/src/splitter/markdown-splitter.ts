import { marked, type Token } from 'marked';
import { nanoid } from 'nanoid';
import type { Section, IndexingConfig } from '@search-docs/types';
import { TokenCounter } from './token-counter.js';

interface HeadingNode {
  depth: number;
  heading: string;
  content: string[];
  children: HeadingNode[];
}

/**
 * Markdownを章立てベースで分割するクラス
 */
export class MarkdownSplitter {
  private tokenCounter: TokenCounter;

  constructor(private config: IndexingConfig) {
    this.tokenCounter = new TokenCounter();
  }

  /**
   * Markdownを分割
   * @param content Markdownテキスト
   * @param documentPath 文書パス
   * @param documentHash 文書ハッシュ
   * @returns セクション配列（vectorなし）
   */
  split(
    content: string,
    documentPath: string,
    documentHash: string
  ): Array<Omit<Section, 'vector'>> {
    // 1. Markdownをパース
    const tokens = marked.lexer(content);

    // 2. 見出し構造を抽出
    const structure = this.extractHeadingStructure(tokens);

    // 3. セクションに変換
    const sections = this.buildSections(structure, documentPath, documentHash);

    return sections;
  }

  /**
   * 見出し構造を抽出
   */
  private extractHeadingStructure(tokens: Token[]): HeadingNode[] {
    const nodes: HeadingNode[] = [];
    let currentDepth0: HeadingNode | null = null;
    let currentDepth1: HeadingNode | null = null;
    let currentDepth2: HeadingNode | null = null;
    let contentBuffer: string[] = [];

    for (const token of tokens) {
      if (token.type === 'heading') {
        const depth = token.depth; // 1-6
        const heading = token.text;

        if (depth === 1) {
          // H1: 新しいdepth 1ノード
          currentDepth1 = { depth: 1, heading, content: [], children: [] };
          nodes.push(currentDepth1);
          currentDepth2 = null;
        } else if (depth === 2) {
          // H2: depth 1の子、またはdepth 2として扱う
          currentDepth2 = { depth: 2, heading, content: [], children: [] };
          if (currentDepth1) {
            currentDepth1.children.push(currentDepth2);
          } else {
            // H1がない場合は直接追加
            nodes.push(currentDepth2);
          }
        } else if (depth === 3) {
          // H3: depth 2の子、またはdepth 3として扱う
          const node = { depth: 3, heading, content: [], children: [] };
          if (currentDepth2) {
            currentDepth2.children.push(node);
          } else if (currentDepth1) {
            currentDepth1.children.push(node);
          } else {
            // 親がない場合は直接追加
            nodes.push(node);
          }
        }
        // H4以降は無視（親セクションに含める）
      } else {
        // コンテンツを現在のノードに追加
        const text = this.tokenToMarkdown(token);

        if (text.trim()) {
          if (currentDepth2 && currentDepth2.children.length === 0) {
            // H3の直前にいる場合はH2に追加
            currentDepth2.content.push(text);
          } else if (currentDepth1 && currentDepth1.children.length === 0) {
            // H2の直前にいる場合はH1に追加
            currentDepth1.content.push(text);
          } else if (currentDepth1 || currentDepth2) {
            // 見出しの後のコンテンツ
            const targetNode = currentDepth2 || currentDepth1;
            if (targetNode) {
              targetNode.content.push(text);
            }
          } else {
            // 見出しのない前文
            contentBuffer.push(text);
          }
        }
      }
    }

    // depth=0は常に文書全体を表す
    // 前文（contentBuffer）を持ち、すべてのH1セクション（nodes）を子として持つ
    currentDepth0 = {
      depth: 0,
      heading: '', // 文書ルート
      content: contentBuffer, // 前文（あれば）
      children: nodes, // すべてのH1セクション
    };

    return [currentDepth0];
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
  ): Array<Omit<Section, 'vector'>> {
    const sections: Array<Omit<Section, 'vector'>> = [];
    let order = orderStart;

    for (const node of nodes) {
      const id = nanoid();
      const content = this.buildContent(node);
      const tokenCount = this.tokenCounter.count(content);

      // トークン数チェック（警告のみ）
      if (tokenCount > this.config.maxTokensPerSection) {
        console.warn(
          `Section "${node.heading || '(document root)'}" in ${documentPath} exceeds maxTokensPerSection (${tokenCount} > ${this.config.maxTokensPerSection})`
        );
      }

      const now = new Date();
      const section: Omit<Section, 'vector'> = {
        id,
        documentPath,
        heading: node.heading || '(document root)',
        depth: Math.min(node.depth, this.config.maxDepth), // maxDepthで制限
        content,
        tokenCount,
        parentId,
        order: order++,
        isDirty: false,
        metadata: {
          documentHash,
          createdAt: now,
          updatedAt: now,
          // サマリフィールド（現時点ではundefined）
          summary: undefined,
          documentSummary: undefined,
        },
      };

      sections.push(section);

      // 子セクションを再帰的に処理
      if (node.children.length > 0 && node.depth < this.config.maxDepth) {
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
   * 親セクションは子のコンテンツを**すべて含む**（階層的コンテンツ）
   */
  private buildContent(node: HeadingNode): string {
    let text = '';

    // 見出しを追加
    if (node.heading) {
      const prefix = '#'.repeat(Math.max(1, node.depth));
      text += `${prefix} ${node.heading}\n\n`;
    }

    // 自分のコンテンツを追加
    text += node.content.join('\n\n');

    // 子のコンテンツを再帰的に追加（階層的コンテンツ）
    if (node.children.length > 0) {
      for (const child of node.children) {
        text += '\n\n' + this.buildContent(child);
      }
    }

    return text.trim();
  }

  /**
   * marked.TokenをMarkdownテキストに変換
   */
  private tokenToMarkdown(token: Token): string {
    // Tokenの生テキストを保持
    try {
      // marked.Tokenには'raw'プロパティがある
      if ('raw' in token && typeof token.raw === 'string') {
        return token.raw;
      }
      // フォールバック: parserを使う（HTMLになる可能性あり）
      return marked.parser([token]);
    } catch (error) {
      // エラー時は空文字列
      console.warn('Failed to convert token to markdown:', error);
      return '';
    }
  }
}
