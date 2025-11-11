/**
 * ツール登録のエクスポート
 */

// 既存ツール
export { registerSearchTool } from './search.js';
export { registerGetDocumentTool } from './get-document.js';
export { registerIndexStatusTool } from './index-status.js';

// 新規ツール
export { registerInitTool } from './init.js';
export { registerServerStartTool, registerServerStopTool } from './server-control.js';
export { registerSystemStatusTool } from './system-status.js';

export type { ToolRegistrationContext, RegisteredTool } from './types.js';
