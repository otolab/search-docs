/**
 * PIDファイル関連の型定義
 */

/**
 * PIDファイルの内容
 */
export interface PidFileContent {
  // プロセス情報
  pid: number;
  startedAt: string; // ISO 8601形式

  // プロジェクト情報
  projectRoot: string;
  projectName: string;

  // サーバ設定
  host: string;
  port: number;
  configPath: string | null;

  // ログ情報（オプション）
  logPath?: string;

  // メタ情報
  version: string;
  nodeVersion: string;
}

/**
 * PIDファイルのパスを取得するヘルパー関数
 * @param projectRoot プロジェクトルートディレクトリ
 * @returns PIDファイルのパス
 */
export function getPidFilePath(projectRoot: string): string {
  // Node.jsの組み込みpathモジュールを使わずに単純な文字列結合
  // これにより、型定義パッケージに余分な依存を持たせない
  return `${projectRoot}/.search-docs/server.pid`;
}
