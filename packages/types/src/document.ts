/**
 * 文書データの型定義
 */

export interface Document {
  /** 文書のパス（キー） */
  path: string;
  /** 全文 */
  content: string;
  /** メタデータ */
  metadata: DocumentMetadata;
}

export interface DocumentMetadata {
  /** タイトル（オプショナル、Markdown等から抽出） */
  title?: string;
  /** 作成日時 */
  createdAt: Date;
  /** 更新日時 */
  updatedAt: Date;
  /** ファイルハッシュ（内容の変更検知用） */
  fileHash: string;
  /** 拡張可能なメタデータ */
  [key: string]: unknown;
}
