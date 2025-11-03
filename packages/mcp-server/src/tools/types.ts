/**
 * ツール登録の共通型定義
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SystemStateInfo } from '../state.js';

/**
 * ツール登録コンテキスト
 */
export interface ToolRegistrationContext {
  /** MCPサーバインスタンス */
  server: McpServer;
  /** システム状態情報 */
  systemState: SystemStateInfo;
}
