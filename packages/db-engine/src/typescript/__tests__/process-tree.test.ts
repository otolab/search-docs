import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { stopProcessTree } from '../process-tree.js';
import { MaintenanceLock } from '../maintenance-lock.js';

describe('Windows の通常停止', () => {
  it('直接の子プロセスに停止を要求し、終了を待つ', async () => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      exitCode: null,
      signalCode: null,
      kill() { setTimeout(() => emitter.emit('exit', 0), 20); return true; },
    }) as unknown as ChildProcess;
    await expect(stopProcessTree(child, 500, 'win32')).resolves.toBeUndefined();
  });
});

const posix = process.platform !== 'win32';
describe.skipIf(!posix)('DB ワーカーのプロセスグループ停止', () => {
  it('親が先に終了しても子孫の終了まで待つ', async () => {
    const childCode = "import signal, time, sys\nsignal.signal(signal.SIGTERM, lambda *_: (time.sleep(0.25), sys.exit(0)))\nprint('ready', flush=True)\nwhile True: time.sleep(1)";
    const parentCode = `const { spawn } = require('child_process'); const child = spawn('python3', ['-u', '-c', ${JSON.stringify(childCode)}]); child.stdout.once('data', () => process.stdout.write('ready\\n')); setInterval(() => {}, 1000);`;
    const worker = spawn(process.execPath, ['-e', parentCode], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(worker.stdout!, 'data');
      const started = Date.now();
      await stopProcessTree(worker, 3000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      try { process.kill(-worker.pid!, 'SIGKILL'); } catch { /* 終了済み */ }
    }
  });

  it('停止を確認できない場合、共有登録を維持する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worker-stop-'));
    const lock = new MaintenanceLock(path.join(root, 'control'));
    const release = await lock.acquireShared();
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(worker.stdout!, 'data');
      await expect(stopProcessTree(worker, 100)).rejects.toThrow(/終了を確認できません/);
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
      process.kill(-worker.pid!, 'SIGKILL');
      await once(worker, 'exit');
      await stopProcessTree(worker, 1000);
      await release();
      const exclusive = await lock.acquireExclusive();
      await exclusive.release();
    } finally {
      try { process.kill(-worker.pid!, 'SIGKILL'); } catch { /* 終了済み */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { deniedSignal: 0, stage: '生存確認' },
    { deniedSignal: 'SIGTERM' as const, stage: '停止要求' },
  ])('$stage で EPERM なら共有登録を維持し、停止未確認として返す', async ({ deniedSignal }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'worker-stop-eperm-'));
    const lock = new MaintenanceLock(path.join(root, 'control'));
    const release = await lock.acquireShared();
    const worker = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(worker, 'close');
    const pid = worker.pid;
    const originalKill = process.kill.bind(process);
    let sigtermAttempted = false;

    try {
      await once(worker.stdout!, 'data');
      if (pid === undefined) throw new Error('worker did not receive a process ID');
      process.kill = ((targetPid: number, signal?: number | NodeJS.Signals) => {
        if (targetPid === -pid && signal === deniedSignal) {
          if (signal === 'SIGTERM') sigtermAttempted = true;
          throw Object.assign(new Error(`injected EPERM at ${String(signal)}`), { code: 'EPERM' });
        }
        return originalKill(targetPid, signal);
      }) as typeof process.kill;

      await expect(stopProcessTree(worker, 100)).rejects.toMatchObject({ code: 'EPERM' });
      expect(sigtermAttempted).toBe(deniedSignal === 'SIGTERM');
      expect(() => originalKill(-pid, 0)).not.toThrow();
      await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    } finally {
      process.kill = originalKill;
      if (pid !== undefined) {
        try { originalKill(-pid, 'SIGKILL'); } catch { /* 終了済み */ }
      }
      if (worker.exitCode === null && worker.signalCode === null) {
        await Promise.race([
          closed,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`worker ${pid} did not close during cleanup`)), 5000)),
        ]);
      }
      await release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
