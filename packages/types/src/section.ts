/**
 * セクションデータの型定義
 */

export interface Section {
  /** セクションID */
  id: string;
  /** 元文書のパス */
  documentPath: string;
  /** 見出し */
  heading: string;
  /** 深度（0-3） */
  depth: number;
  /** 内容 */
  content: string;
  /** トークン数 */
  tokenCount: number;
  /** ベクトル表現 */
  vector: Float32Array;
  /** 親セクションID */
  parentId: string | null;
  /** 文書内の順序 */
  order: number;
  /** Dirtyフラグ */
  isDirty: boolean;
  /** メタデータ */
  metadata: SectionMetadata;
}

export interface SectionMetadata {
  /** 作成日時 */
  createdAt: Date;
  /** 更新日時 */
  updatedAt: Date;
  /** 対応する文書のハッシュ */
  documentHash: string;
}
