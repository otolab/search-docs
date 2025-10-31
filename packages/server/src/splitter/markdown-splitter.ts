import { marked, type Token, type Tokens } from 'marked';
import { nanoid } from 'nanoid';
import type { Section, IndexingConfig } from '@search-docs/types';
import { TokenCounter } from './token-counter.js';

interface HeadingNode {
  depth: number;
  heading: string;
  content: string[];
  children: HeadingNode[];
  // 位置情報（Task 14 Phase 2）
  startLine: number;    // 開始行（1-indexed）
  endLine: number;      // 終了行（1-indexed）
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
    const structure = this.extractHeadingStructure(tokens, content);

    // 3. セクションに変換
    const sections = this.buildSections(structure, documentPath, documentHash);

    return sections;
  }

  /**
   * 見出し構造を抽出
   */
  private extractHeadingStructure(tokens: Token[], content: string): HeadingNode[] {
    const nodes: HeadingNode[] = [];
    let currentDepth0: HeadingNode | null = null;
    let currentDepth1: HeadingNode | null = null;
    let currentDepth2: HeadingNode | null = null;
    let currentDepth3: HeadingNode | null = null;
    const contentBuffer: string[] = [];
    let currentLine = 1;  // 現在の行番号（1-indexed）

    for (const token of tokens) {
      const tokenRaw = 'raw' in token && typeof token.raw === 'string' ? token.raw : '';
      const tokenStartLine = currentLine;
      // トークンの行数を計算
      const tokenLines = tokenRaw.split('\n').length - 1;
      const tokenEndLine = currentLine + tokenLines;
      if (token.type === 'heading') {
        // 型ガード: heading型であることを明示
        const headingToken = token as Tokens.Heading;
        const depth = headingToken.depth; // 1-6
        const heading = headingToken.text;

        if (depth === 1) {
          // H1: 新しいdepth 1ノード
          currentDepth1 = {
            depth: 1,
            heading,
            content: [],
            children: [],
            startLine: tokenStartLine,
            endLine: tokenEndLine,
          };
          nodes.push(currentDepth1);
          currentDepth2 = null;
          currentDepth3 = null;
        } else if (depth === 2) {
          // H2: depth 1の子、またはdepth 2として扱う
          currentDepth2 = {
            depth: 2,
            heading,
            content: [],
            children: [],
            startLine: tokenStartLine,
            endLine: tokenEndLine,
          };
          if (currentDepth1) {
            currentDepth1.children.push(currentDepth2);
          } else {
            // H1がない場合は直接追加
            nodes.push(currentDepth2);
          }
          currentDepth3 = null;
        } else if (depth === 3) {
          // H3: depth 2の子、またはdepth 3として扱う
          currentDepth3 = {
            depth: 3,
            heading,
            content: [],
            children: [],
            startLine: tokenStartLine,
            endLine: tokenEndLine,
          };
          if (currentDepth2) {
            currentDepth2.children.push(currentDepth3);
          } else if (currentDepth1) {
            currentDepth1.children.push(currentDepth3);
          } else {
            // 親がない場合は直接追加
            nodes.push(currentDepth3);
          }
        }
        // H4以降は無視（親セクションに含める）
      } else {
        // コンテンツを現在のノードに追加
        const text = this.tokenToMarkdown(token);

        if (text.trim()) {
          // 最も深い現在のノードを選択
          const targetNode = currentDepth3 || currentDepth2 || currentDepth1;

          if (targetNode) {
            targetNode.content.push(text);
            // endLineを更新
            targetNode.endLine = tokenEndLine;
          } else {
            // 見出しのない前文
            contentBuffer.push(text);
          }
        }
      }

      // 次のトークンのために行番号を更新
      currentLine = tokenEndLine;
    }

    // depth=0は常に文書全体を表す
    // 前文（contentBuffer）を持ち、すべてのH1セクション（nodes）を子として持つ
    const totalLines = content.split('\n').length;
    currentDepth0 = {
      depth: 0,
      heading: '', // 文書ルート
      content: contentBuffer, // 前文（あれば）
      children: nodes, // すべてのH1セクション
      startLine: 1,
      endLine: totalLines,
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
    orderStart: number = 0,
    parentSectionNumber: number[] = []
  ): Array<Omit<Section, 'vector'>> {
    const sections: Array<Omit<Section, 'vector'>> = [];
    let order = orderStart;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const id = nanoid();
      const content = this.buildContent(node);
      const tokenCount = this.tokenCounter.count(content);

      // トークン数チェック（警告のみ）
      if (tokenCount > this.config.maxTokensPerSection) {
        console.warn(
          `Section "${node.heading || '(document root)'}" in ${documentPath} exceeds maxTokensPerSection (${tokenCount} > ${this.config.maxTokensPerSection})`
        );
      }

      // 行番号はHeadingNodeに保存済み
      const startLine = node.startLine;
      const endLine = node.endLine;
      // セクション番号（階層的な配列、例: [1], [1, 2], [1, 2, 1]）
      const sectionNumber = [...parentSectionNumber, i + 1];

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
        // メタデータフィールド（フラット構造）
        documentHash,
        createdAt: now,
        updatedAt: now,
        summary: undefined,
        documentSummary: undefined,
        // Task 14 Phase 2: 行番号とセクション番号
        startLine,
        endLine,
        sectionNumber,
      };

      sections.push(section);

      // 子セクションを再帰的に処理
      if (node.children.length > 0 && node.depth < this.config.maxDepth) {
        const childSections = this.buildSections(
          node.children,
          documentPath,
          documentHash,
          id,
          0,
          sectionNumber
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
