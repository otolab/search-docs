// Test-only MCP process. Purge operates only on this test's temporary directory.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { MaintenanceLock } from '@search-docs/db-engine';
import path from 'node:path';
import { createService } from '../dist/state.js';
import { ServiceLifecycle, registerShutdownHandlers } from '../dist/service-lifecycle.js';
import { RequestGate, gateService } from '../dist/maintenance/request-gate.js';
import { registerIndexPurgeTool } from '../dist/tools/index-purge.js';

console.log = (...args) => console.error(...args);
const root = process.argv[2];
const embeddingUrl = process.argv[3];
const config = {
  ...DEFAULT_CONFIG,
  project: { name: 'test', root },
  files: { ...DEFAULT_CONFIG.files, sources: [], respectGitignore: false },
  indexing: { ...DEFAULT_CONFIG.indexing, embeddingUrl },
  watcher: { ...DEFAULT_CONFIG.watcher, enabled: false },
  worker: { ...DEFAULT_CONFIG.worker, enabled: false },
};
let instances = await createService(config, root, 'test');
await instances.dbEngine.connect();
const gate = new RequestGate();
let service = gateService(instances.service, gate);
const lifecycle = new ServiceLifecycle(async () => {
  instances = await createService(config, root, 'test');
  await instances.dbEngine.connect();
  service = gateService(instances.service, gate);
}, () => instances, value => { instances = value; });
const server = new McpServer({ name: 'maintenance-test', version: '1' });
registerIndexPurgeTool({
  server, systemState: { state: 'RUNNING', config, projectRoot: root },
  runMaintenance: operation => lifecycle.maintenance(gate, () => {}, operation),
});
let releaseHold;
server.registerTool('hold', { inputSchema: {} }, async () => gate.run(async () => {
  await new Promise(resolve => { releaseHold = resolve; });
  return { content: [{ type: 'text', text: 'released' }] };
}));
server.registerTool('release', { inputSchema: {} }, async () => {
  if (releaseHold) releaseHold();
  return { content: [{ type: 'text', text: 'ok' }] };
});
server.registerTool('probe', { inputSchema: {} }, async () => {
  await service.getStatus();
  return { content: [{ type: 'text', text: 'ok' }] };
});
server.registerTool('maintenance', { inputSchema: {} }, async () => {
  await lifecycle.maintenance(gate, () => {}, async () => {
    const lease = await new MaintenanceLock(path.join(root, '.search-docs/.search-docs-maintenance')).acquireExclusive();
    await lease.release();
  });
  return { content: [{ type: 'text', text: 'restarted' }] };
});
registerShutdownHandlers(process, () => lifecycle.shutdown(), code => process.exit(code), error => console.error(error));
await server.connect(new StdioServerTransport());
