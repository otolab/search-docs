/**
 * ツール登録の共通型定義
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SystemStateInfo } from '../state.js';

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
}
