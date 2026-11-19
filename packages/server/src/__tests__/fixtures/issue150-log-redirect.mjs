import { setupLogRedirect } from '../../../dist/utils/log-redirect.js';
import { WatcherProcess } from '../../../dist/watcher/watcher-process.js';

setupLogRedirect(process.argv[2]);
const config = {
  project: { root: process.cwd() },
  files: { sources: ['**/*.md'], exclude: [], ignoreGitignore: false },
  indexing: { maxTokensPerSection: 2000, minTokensForSplit: 100, maxDepth: 3 },
  watcher: { enabled: false }, worker: { enabled: false },
};
const db = { updateHeartbeat: async () => {}, releaseWriter: async () => ({ success: true }), disconnect() {} };
const writer = new WatcherProcess(config, {}, db);
writer.writerState = 'watching';
if (process.argv[3] === 'rotate') {
  for (let i = 0; i < 5; i++) writer.reportWarning(`rotation-${i}: ${'x'.repeat(1024 * 1024)}`);
} else {
  for (let i = 0; i < 26; i++) writer.reportWarning(`candidate-${i}: ${'x'.repeat(600)}`);
}
await writer.stop();
