import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcessTree } from '../process.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('killProcessTree', () => {
  it.skipIf(process.platform === 'win32')('sends SIGKILL after the process group ignores SIGTERM', async () => {
    let groupAlive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== -54321) return true;
      if (signal === 'SIGKILL') groupAlive = false;
      if (signal === 0) {
        if (groupAlive) return true;
        throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    await killProcessTree(54321, 0);

    expect(kill).toHaveBeenCalledWith(-54321, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-54321, 'SIGKILL');
    expect(groupAlive).toBe(false);
  });

  it('releases the listener port before resolving', async () => {
    const child = spawn(process.execPath, [
      '-e',
      [
        "const net = require('node:net');",
        "const server = net.createServer();",
        "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
      ].join(' '),
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('listener child did not start')), 5000);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/\d+/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[0]));
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    try {
      await killProcessTree(child.pid!);

      const replacement = net.createServer();
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen(port, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve, reject) => {
        replacement.close((error) => error ? reject(error) : resolve());
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await killProcessTree(child.pid!);
      }
    }
  });
});
