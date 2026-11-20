import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DBEngine } from '../index.js';
import { MaintenanceLock } from '../maintenance-lock.js';

describe.skipIf(process.platform === 'win32')('DBEngine.disconnect', () => {
  it('保守操作中はサービス外診断を開始しない', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'db-diagnostic-lock-'));
    const lock = new MaintenanceLock(path.join(root, '.search-docs-maintenance'));
    const exclusive = await lock.acquireExclusive();
    try {
      const engine = new DBEngine({ dbPath: path.join(root, 'index') });
      await expect(engine.diagnoseDuplicateSections()).rejects.toThrow(/保守操作/);
    } finally {
      await exclusive.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('子プロセスの終了まで待機する', async () => {
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(worker.stdout!, 'data');
      const engine = new DBEngine();
      const internal = engine as unknown as { worker: typeof worker; workerGroups: Set<typeof worker> };
      internal.worker = worker;
      internal.workerGroups.add(worker);
      const start = Date.now();
      const stopping = engine.disconnect();
      await expect(engine.connect()).rejects.toThrow(/停止中/);
      await expect(engine.diagnoseDuplicateSections()).rejects.toThrow(/停止中/);
      await stopping;
      expect(Date.now() - start).toBeGreaterThanOrEqual(150);
      expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
    } finally {
      try { process.kill(-worker.pid!, 'SIGKILL'); } catch { /* 終了済み */ }
    }
  });

  it('停止が失敗した場合、登録を解放する後続処理を実行しない', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'db-disconnect-'));
    const lock = new MaintenanceLock(path.join(root, 'control'));
    const release = await lock.acquireShared();
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const engine = new DBEngine();
    const internal = engine as unknown as { worker: typeof worker; workerGroups: Set<typeof worker> };
    internal.worker = worker;
    internal.workerGroups.add(worker);
    const originalKill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -worker.pid!) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      return originalKill(pid, signal);
    });
    try {
      await expect(engine.disconnect().then(release)).rejects.toThrow('permission denied');
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    } finally {
      spy.mockRestore();
      try { process.kill(-worker.pid!, 'SIGKILL'); } catch { /* 終了済み */ }
      await once(worker, 'exit');
      await rm(root, { recursive: true, force: true });
    }
  });
});
