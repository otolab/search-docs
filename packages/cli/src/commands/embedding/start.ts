/**
 * embedding start コマンド
 */

import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_EMBEDDING_PORT,
  isPortAvailable,
  checkEmbeddingHealth,
  waitForEmbeddingReady,
  embeddingDir,
  embeddingPidPath,
  embeddingLogPath,
  readEmbeddingPidFile,
} from '../../utils/embedding.js';
import { getListeningProcess, isProcessAlive } from '../../utils/process.js';

export interface EmbeddingStartOptions {
  port?: string | number;
  foreground?: boolean;
  runtime?: 'onnx' | 'torch';
  dimension?: string | number;
}

export async function executeEmbeddingStart(options: EmbeddingStartOptions): Promise<void> {
  try {
    await startEmbeddingServer(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exitCode = 1;
  }
}

function parsePort(value: string | number | undefined): number {
  const port = value === undefined ? DEFAULT_EMBEDDING_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

function parseDimension(value: string | number | undefined): number {
  const dimension = value === undefined ? 256 : Number(value);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`Invalid dimension: ${String(value)}`);
  }
  return dimension;
}

function formatOwner(owner: { pid: number; command?: string } | null): string {
  if (!owner) return 'owner PID could not be determined';
  return `PID ${owner.pid}${owner.command ? ` (${owner.command})` : ''}`;
}

async function removeStalePidFile(): Promise<void> {
  await unlink(embeddingPidPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function startEmbeddingServer(options: EmbeddingStartOptions): Promise<void> {
  const port = parsePort(options.port);
  const runtime = options.runtime ?? 'onnx';
  const dimension = parseDimension(options.dimension);
  const pidState = await readEmbeddingPidFile();

  // 起動前診断: PIDファイルがあってもプロセスが死んでいれば先に修復する。
  if (pidState.error) {
    console.warn(`Warning: ${pidState.error}. Removing unusable PID file.`);
    await removeStalePidFile();
  } else if (pidState.value && !isProcessAlive(pidState.value.pid)) {
    console.log(`Removing stale embedding PID file (PID: ${pidState.value.pid}).`);
    await removeStalePidFile();
  } else if (pidState.value) {
    const managedHealth = await checkEmbeddingHealth('127.0.0.1', pidState.value.port, 1000);
    const managedOwner = getListeningProcess(pidState.value.port);
    if (managedHealth && managedOwner && managedOwner.pid !== pidState.value.pid) {
      throw new Error(
        `PID file points to PID ${pidState.value.pid}, but port ${pidState.value.port} ` +
        `is owned by external ${formatOwner(managedOwner)}. ` +
        `Use embedding stop --port ${pidState.value.port} only after confirming the target.`,
      );
    }
    if (managedHealth) {
      throw new Error(
        `Embedding server is already managed (PID: ${pidState.value.pid}, port: ${pidState.value.port}). ` +
        `Stop it before starting another server.`,
      );
    }

    throw new Error(
      `PID file points to live PID ${pidState.value.pid}, but the embedding server is not healthy ` +
      `(port ${pidState.value.port}, ${formatOwner(managedOwner)}). ` +
      'Inspect the process or use embedding stop --port after confirming the target.',
    );
  }

  // PIDファイルの診断で外部サーバを見つけた場合は、PIDファイルを上書きしない。
  const existing = await checkEmbeddingHealth('127.0.0.1', port);
  if (existing) {
    const owner = getListeningProcess(port);
    console.log(`Embedding server is already running externally on port ${port}.`);
    console.log(`  Model: ${existing.model}`);
    console.log(`  Dimension: ${existing.vectorDimension}`);
    console.log(`  Liveness: ${existing.status}`);
    console.log(`  Readiness: ${existing.ready === true ? 'ready' : 'not reported/ready'}`);
    console.log(`  Owner: ${formatOwner(owner)}`);
    console.log('  No search-docs PID file was written; the external server is not managed by this command.');
    return;
  }

  if (!(await isPortAvailable(port))) {
    const owner = getListeningProcess(port);
    throw new Error(
      `Port ${port} is already in use by ${formatOwner(owner)}. ` +
      `Use --port with a free port or stop the owning process after confirming it.`,
    );
  }

  // db-engine パッケージのパスを解決
  const dbEngineRoot = resolveDbEngineRoot();
  const scriptPath = path.join(dbEngineRoot, 'src/python/embedding_server.py');

  const args = [
    '--project', dbEngineRoot, 'run', 'python',
    scriptPath,
    `--port=${port}`,
    `--runtime=${runtime}`,
    `--dimension=${dimension}`,
  ];

  console.log(`Starting embedding server (runtime: ${runtime}, port: ${port})...`);

  if (options.foreground) {
    // フォアグラウンド起動
    const proc = spawn('uv', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    await new Promise<void>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('exit', () => resolve());
    });
    return;
  }

  // デーモン起動
  const pidDir = embeddingDir();
  await mkdir(pidDir, { recursive: true });

  const logPath = embeddingLogPath();
  const logFd = openSync(logPath, 'a');

  const proc = spawn('uv', args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  closeSync(logFd);

  if (!proc.pid) {
    throw new Error('Failed to start embedding server process');
  }

  proc.unref();

  // readiness 待ち（初回はモデルダウンロードで時間がかかる）
  console.log('Waiting for embedding server to become ready (initial download may take a few minutes)...');
  const ready = await waitForEmbeddingReady('127.0.0.1', port, 120000);

  if (!ready) {
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`Embedding server did not become ready within 120s.\nCheck log: ${logPath}`);
  }

  // PIDファイル保存。外部サーバのPIDファイルを上書きする経路は上で排除済み。
  const health = await checkEmbeddingHealth('127.0.0.1', port);
  const pidFile = {
    pid: proc.pid,
    port,
    startedAt: new Date().toISOString(),
    model: health?.model ?? 'unknown',
    dimension: health?.vectorDimension ?? dimension,
    logPath,
  };

  await writeFile(
    embeddingPidPath(),
    JSON.stringify(pidFile, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );

  console.log(`Embedding server started successfully (PID: ${proc.pid})`);
  console.log(`  Model: ${pidFile.model}`);
  console.log(`  Dimension: ${pidFile.dimension}`);
  console.log(`  Port: ${port}`);
  console.log(`  Log: ${logPath}`);
}

function resolveDbEngineRoot(): string {
  try {
    const dbEngineModulePath = import.meta.resolve('@search-docs/db-engine');
    const dbEngineModuleFile = fileURLToPath(dbEngineModulePath);
    return path.resolve(path.dirname(dbEngineModuleFile), '..');
  } catch {
    // フォールバック: ワークスペースの相対パス
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../../../../db-engine');
  }
}
