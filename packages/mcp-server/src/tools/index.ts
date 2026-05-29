/**
 * ツール登録のエクスポート
 */

// 既存ツール
export { registerSearchTool } from './search.js';
export { registerGetDocumentTool } from './get-document.js';
export { registerGetOutlineTool } from './get-outline.js';
export { registerIndexStatusTool } from './index-status.js';

// 新規ツール
export { registerInitTool } from './init.js';
export { registerSystemStatusTool } from './system-status.js';
export { registerListRelatedProjectsTool } from './list-related-projects.js';
export { registerAddRelatedProjectTool } from './add-related-project.js';
export { registerMaintenanceRepairTool } from './maintenance-repair.js';
export { registerIndexPurgeTool } from './index-purge.js';

export type { ToolRegistrationContext, RegisteredTool } from './types.js';
