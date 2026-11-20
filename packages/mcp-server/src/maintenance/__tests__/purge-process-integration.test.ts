import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DBEngine, MaintenanceLock } from '@search-docs/db-engine';
import { exclusivePurge } from '../exclusive-purge.js';
import { RequestGate } from '../request-gate.js';
import { ServiceLifecycle } from '../../service-lifecycle.js';
import type { ServiceInstances } from '../../state.js';

describe.skipIf(process.platform === 'win32')('実プロセスと DB を使う purge 手順', () => {
  it('別プロセスの登録を拒否し、DB 子プロセスの停止後に排他削除・再接続する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'purge-real-process-'));
    const layout = { indexPath: path.join(root, 'index'), documentsPath: path.join(root, 'documents'), managementPath: path.join(root, 'control') };
    await mkdir(layout.indexPath);
    await writeFile(path.join(layout.indexPath, 'keep'), 'keep');
    const script = `import { MaintenanceLock } from '@search-docs/db-engine';
const release = await new MaintenanceLock(process.argv[1]).acquireShared();
process.stdout.write('ready\\n');
process.stdin.once('data', async () => { await release(); process.exit(0); });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, layout.managementPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lock = new MaintenanceLock(layout.managementPath);
    let engine: DBEngine | undefined;
    let activeRelease: (() => Promise<void>) | undefined;
    const start = async () => {
      activeRelease = await lock.acquireShared();
      engine = new DBEngine({ dbPath: layout.indexPath });
      await engine.connect({ skipInitModel: true });
      return {
        watcherProcess: { stop: async () => {} },
        service: { stop: async () => { await engine!.disconnect(); } },
        dbEngine: engine,
        embeddingServer: { shutdown: () => {} },
        releaseStorageRegistration: activeRelease,
      } as unknown as ServiceInstances;
    };
    try {
      const [ready] = await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('registration process exited'); })]);
      expect(String(ready)).toContain('ready');
      let current: ServiceInstances | null = await start();
      const firstEngine = engine!;
      const gate = new RequestGate();
      const lifecycle = new ServiceLifecycle(async () => { current = await start(); }, () => current, value => { current = value; });
      let removed = false;
      const remove = async () => {
        expect(firstEngine.getConnectionState().state).toBe('disconnected');
        removed = true;
        await rm(layout.indexPath, { recursive: true });
      };
      await expect(lifecycle.maintenance(gate, () => {}, () => exclusivePurge({ confirmed: true, validate: async () => layout, remove }))).rejects.toThrow(/使用中/);
      expect(removed).toBe(false);
      expect(await readFile(path.join(layout.indexPath, 'keep'), 'utf8')).toBe('keep');
      const exited = once(child, 'exit');
      child.stdin!.write('release\n');
      await exited;
      current = await start();
      const retryEngine = engine!;
      const workerPid = (retryEngine as unknown as { worker: { pid?: number } }).worker.pid;
      expect(workerPid).toBeDefined();
      const retryGate = new RequestGate();
      const retry = new ServiceLifecycle(async () => { current = await start(); }, () => current, value => { current = value; });
      await retry.maintenance(retryGate, () => {}, () => exclusivePurge({ confirmed: true, validate: async () => layout, remove: async () => {
        expect(retryEngine.getConnectionState().state).toBe('disconnected');
        expect(() => process.kill(-workerPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        removed = true;
        await rm(layout.indexPath, { recursive: true });
      } }));
      expect(removed).toBe(true);
      expect(engine!.getConnectionState().state).toBe('ready');
      await retry.shutdown();
      activeRelease = undefined;
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      await engine?.disconnect();
      await activeRelease?.().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
