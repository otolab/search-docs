/**
 * テスト用の型定義
 */

/**
 * MCP型定義
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface MCPToolsListResponse {
  tools: MCPTool[];
}

export interface MCPTextContent {
  type: 'text';
  text: string;
}

export interface MCPToolResult {
  content?: MCPTextContent[];
}
