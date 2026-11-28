import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingServer } from '../start.js';
import { stopEmbeddingServer } from '../stop.js';
import {
  embeddingPidPath,
  embeddingPidPathForPort,
  readEmbeddingPidFile,
} from '../../../utils/embedding.js';
import {
  isPortAvailable,
  killProcessTree,
  killProcessTreeWithCommandMarker,
} from '../../../utils/process.js';

let temporaryRoot: string | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
  if (temporaryRoot) {
    try {
      const launcherPid = Number(await readFile(path.join(temporaryRoot, 'home', 'launcher.pid'), 'utf8'));
      const launchId = await readFile(path.join(temporaryRoot, 'home', 'launcher-id'), 'utf8');
      if (Number.isInteger(launcherPid) && launcherPid > 0 && launchId) {
        await killProcessTreeWithCommandMarker(
          launcherPid,
          `--search-docs-startup-id=${launchId}`,
        ).catch(() => {});
      }
    } catch {
      // No fake launcher was started.
    }
  }
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await killProcessTree(child.pid).catch(() => {});
    }
  }
  vi.unstubAllEnvs();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

async function prepareFakeUv(mode: 'server' | 'hold'): Promise<string> {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'embedding-ownership-'));
  const home = path.join(temporaryRoot, 'home');
  const bin = path.join(temporaryRoot, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(path.join(home, '.search-docs'));
  await mkdir(bin, { recursive: true });
  const launcher = path.join(temporaryRoot, 'fake-uv.cjs');
  await writeFile(launcher, `
const fs = require('node:fs');
const http = require('node:http');
const marker = process.argv.slice(2).find((arg) => arg.startsWith('--search-docs-startup-id='));
fs.writeFileSync(process.env.HOME + '/launcher.pid', String(process.pid));
fs.writeFileSync(process.env.HOME + '/launcher-id', marker.split('=')[1]);
if (process.env.ISSUE167_FAKE_UV_MODE === 'hold') {
  setInterval(() => {}, 1000);
} else {
  const args = process.argv.slice(2);
  const port = Number(args.find((arg) => arg.startsWith('--port=')).split('=')[1]);
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/ready'
      ? { ready: true }
      : { status: 'ok', model: 'fixture', vectorDimension: 256, ready: true }));
  });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
`);
  const uv = path.join(bin, 'uv');
  await writeFile(
    uv,
    `#!/bin/sh\nexec "${process.execPath}" "${launcher}" "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(uv, 0o700);
  vi.stubEnv('HOME', home);
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('ISSUE167_FAKE_UV_MODE', mode);
  return home;
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function startExternalServer(port: number, home: string): Promise<ChildProcess> {
  const script = path.join(temporaryRoot!, 'external-server.cjs');
  await writeFile(script, `
const http = require('node:http');
const port = Number(process.argv[2]);
const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'ok', model: 'external', vectorDimension: 256, ready: true }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [script, String(port)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HOME: home },
  });
  children.push(child);
  await vi.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    expect(response?.status).toBe(200);
  }, { timeout: 5000 });
  return child;
}

describe.skipIf(process.platform === 'win32')('embedding process ownership', () => {
  it('starts, stops, restarts, and selects separate port records', async () => {
    await prepareFakeUv('server');
    const firstPort = await reservePort();
    const secondPort = await reservePort();

    await startEmbeddingServer({ port: firstPort, readyTimeout: 5000 });
    expect((await readEmbeddingPidFile(embeddingPidPathForPort(firstPort))).value?.launchId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await stopEmbeddingServer();
    expect(await readEmbeddingPidFile(embeddingPidPathForPort(firstPort))).toMatchObject({
      exists: false,
    });

    await startEmbeddingServer({ port: firstPort, readyTimeout: 5000 });
    await stopEmbeddingServer();

    await startEmbeddingServer({ port: firstPort, readyTimeout: 5000 });
    await startEmbeddingServer({ port: secondPort, readyTimeout: 5000 });
    await expect(stopEmbeddingServer()).rejects.toThrow(/Specify --port <port>/);
    await stopEmbeddingServer({ port: firstPort });
    expect((await readEmbeddingPidFile(embeddingPidPathForPort(secondPort))).value?.port).toBe(secondPort);
    await stopEmbeddingServer({ port: secondPort });
  });

  it('leaves a competing ready server unregistered and untouched', async () => {
    const port = await reservePort();
    const home = await prepareFakeUv('hold');
    const starting = startEmbeddingServer({ port, readyTimeout: 5000 });
    await waitForFile(path.join(home, 'launcher.pid'));
    const external = await startExternalServer(port, home);

    await expect(starting).rejects.toThrow(/could not be verified as this launch/);

    expect(await readEmbeddingPidFile(embeddingPidPathForPort(port))).toMatchObject({ exists: false });
    await writeFile(embeddingPidPath(), JSON.stringify({
      pid: external.pid,
      port,
      startedAt: new Date().toISOString(),
    }));
    await expect(stopEmbeddingServer()).rejects.toThrow(/legacy records cannot prove ownership/);
    const stillServing = await fetch(`http://127.0.0.1:${port}/health`);
    expect(stillServing.status).toBe(200);
    const health = await stillServing.json() as { model?: string };
    expect(health.model).toBe('external');
    expect(await isPortAvailable(port)).toBe(false);
    await killProcessTree(external.pid!);
  });

  it('reads the legacy file without trusting it for ordinary stop', async () => {
    await prepareFakeUv('server');
    const port = await reservePort();
    const external = await startExternalServer(port, path.join(temporaryRoot!, 'home'));
    await writeFile(embeddingPidPath(), JSON.stringify({
      pid: external.pid,
      port,
      startedAt: new Date().toISOString(),
    }));

    await expect(stopEmbeddingServer()).rejects.toThrow(/legacy records cannot prove ownership/);
    expect(await isPortAvailable(port)).toBe(false);
    await stopEmbeddingServer({ port });
    expect(await isPortAvailable(port)).toBe(true);
  });
});
