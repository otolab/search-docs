/**
 * DocumentStorageインターフェイス
 */

import type { Document } from './document.js';

export interface DocumentStorage {
  /**
   * 文書を保存
   */
  save(path: string, document: Document): Promise<void>;

  /**
   * 文書を取得
   */
  get(path: string): Promise<Document | null>;

  /**
   * 文書を削除
   */
  delete(path: string): Promise<void>;

  /**
   * すべての文書パスを取得
   */
  list(): Promise<string[]>;

  /**
   * 文書の存在確認
   */
  exists(path: string): Promise<boolean>;
}
