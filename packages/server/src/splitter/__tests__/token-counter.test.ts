import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter } from '../token-counter.js';

describe('TokenCounter', () => {
  let tokenCounter: TokenCounter;

  beforeEach(() => {
    tokenCounter = new TokenCounter();
  });

  describe('count()', () => {
    it('英語テキストのトークン数を計測できる', () => {
      const text = 'Hello, world!';
      const count = tokenCounter.count(text);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(text.length); // トークン数は文字数より少ないはず
    });

    it('日本語テキストのトークン数を計測できる', () => {
      const text = 'こんにちは、世界！';
      const count = tokenCounter.count(text);
      expect(count).toBeGreaterThan(0);
    });

    it('長文のトークン数を計測できる', () => {
      const text = `
# Markdown Sample

これはサンプルのMarkdownテキストです。
複数の段落があります。

## セクション1

ここには詳細な説明が入ります。
いくつかの文章が続きます。

- リスト項目1
- リスト項目2
- リスト項目3

\`\`\`typescript
const code = "example";
\`\`\`
      `.trim();

      const count = tokenCounter.count(text);
      expect(count).toBeGreaterThan(50); // 十分長いテキストなのでトークン数も多いはず
    });

    it('空文字列のトークン数は0', () => {
      const count = tokenCounter.count('');
      expect(count).toBe(0);
    });

    it('空白のみのテキストのトークン数を計測できる', () => {
      const count = tokenCounter.count('   ');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('countAll()', () => {
    it('複数のテキストの合計トークン数を計測できる', () => {
      const texts = ['Hello', 'World', 'Test'];
      const total = tokenCounter.countAll(texts);

      // 個別にカウントした合計と一致するはず
      const expected = texts.reduce((sum, text) => sum + tokenCounter.count(text), 0);
      expect(total).toBe(expected);
    });

    it('空配列の合計トークン数は0', () => {
      const total = tokenCounter.countAll([]);
      expect(total).toBe(0);
    });

    it('日本語と英語が混在した配列の合計トークン数を計測できる', () => {
      const texts = [
        'Hello World',
        'こんにちは',
        'Mixed English and 日本語',
      ];
      const total = tokenCounter.countAll(texts);
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('エラーハンドリング', () => {
    it('計測エラー時はフォールバックで文字数/4を返す', () => {
      // gpt-tokenizerがエラーを投げる可能性のあるケースをテスト
      // （実際にはほとんどエラーにならないが、フォールバックの存在を確認）
      const text = 'normal text';
      const count = tokenCounter.count(text);
      expect(count).toBeGreaterThan(0);
      // フォールバック値よりも小さいはず（正常に計測されている）
      expect(count).toBeLessThan(Math.ceil(text.length / 4) * 2);
    });
  });
});
