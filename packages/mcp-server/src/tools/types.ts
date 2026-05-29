/**
 * ツール登録の共通型定義
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DBEngine } from '@search-docs/db-engine';
import type { SystemStateInfo } from '../state.js';
import type { ServerManager } from '../server-manager.js';

/**
 * 登録されたツールのハンドル
 * registerTool()の戻り値の型
 */
export type RegisteredTool = ReturnType<McpServer['registerTool']>;

/**
 * ツール登録コンテキスト
 */
export interface ToolRegistrationContext {
  /** MCPサーバインスタンス */
  server: McpServer;
  /** システム状態情報 */
  systemState: SystemStateInfo;
  /** システム状態を再検出する関数 */
  refreshSystemState: () => Promise<void>;
  /** サーバマネージャー（複数プロジェクト管理用） */
  serverManager: ServerManager;
  /** DBEngineインスタンスの取得（メンテナンス操作用） */
  getDbEngine?: () => DBEngine | null;
}
