/**
 * セクションデータの型定義
 *
 * Note: Python DBスキーマとの一致のため、フラット構造を採用
 * メタデータフィールドはネストせず、トップレベルに配置
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
  /** 対応する文書のハッシュ */
  documentHash: string;
  /** 作成日時 */
  createdAt: Date;
  /** 更新日時 */
  updatedAt: Date;
  /** セクションの要約（後で生成） */
  summary?: string;
  /** 文書全体の要約（コンテキスト保持用） */
  documentSummary?: string;
  /** セクション開始行（1-indexed） */
  startLine: number;
  /** セクション終了行（1-indexed） */
  endLine: number;
  /** 階層的なセクション番号（例: [1], [1, 2], [1, 2, 1]） */
  sectionNumber: number[];
}
