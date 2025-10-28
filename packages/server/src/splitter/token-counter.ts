import { encode } from 'gpt-tokenizer';

/**
 * トークン数をカウントするクラス
 */
export class TokenCounter {
  /**
   * テキストのトークン数を計測
   * @param text 計測するテキスト
   * @returns トークン数
   */
  count(text: string): number {
    try {
      const tokens = encode(text);
      return tokens.length;
    } catch (_error) {
      // エラー時は文字数の1/4を概算値として使用
      // （日本語は平均2-3文字で1トークン、英語は平均4文字で1トークン）
      console.warn('Token counting failed, using character count / 4 as fallback');
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * 複数のテキストの合計トークン数を計測
   */
  countAll(texts: string[]): number {
    return texts.reduce((sum, text) => sum + this.count(text), 0);
  }
}
