// Test-only service. All paths and the embedding endpoint belong to the parent test.
import { createService, stopService } from '../dist/state.js';
import { registerMaintenanceRepairTool } from '../dist/tools/maintenance-repair.js';

console.log = (...args) => console.error(...args);
const config = JSON.parse(process.argv[2]);
let instance;
let handler;
try {
  instance = await createService(config, config.project.root, 'test');
  registerMaintenanceRepairTool({
    server: { registerTool: (_name, _options, callback) => { handler = callback; return {}; } },
    systemState: { state: 'RUNNING', config, projectRoot: config.project.root },
    getDbEngine: () => instance.dbEngine,
  });
  process.send({ ready: true });
  process.on('message', async ({ id, action }) => {
    try {
      if (action === 'status') process.send({ id, result: instance.watcherProcess.getStatus() });
      if (action === 'repair') process.send({ id, result: await handler() });
      if (action === 'stop') {
        await stopService(instance);
        process.send({ id, result: true });
        process.disconnect();
      }
    } catch (error) {
      process.send({ id, error: String(error) });
    }
  });
} catch (error) {
  process.send({ error: String(error) });
  process.exitCode = 1;
}
