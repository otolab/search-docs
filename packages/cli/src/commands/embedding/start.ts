/**
 * embedding start コマンド
 */

import { spawn } from 'child_process';
import { openSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isPortAvailable, checkEmbeddingHealth, waitForEmbeddingReady, embeddingDir, embeddingPidPath, embeddingLogPath } from '../../utils/embedding.js';

export interface EmbeddingStartOptions {
  port?: string;
  foreground?: boolean;
  runtime?: 'onnx' | 'torch';
  dimension?: string;
}

export async function executeEmbeddingStart(options: EmbeddingStartOptions): Promise<void> {
  try {
    await startEmbeddingServer(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

async function startEmbeddingServer(options: EmbeddingStartOptions): Promise<void> {
  const port = options.port ? parseInt(options.port, 10) : 24281;
  const runtime = options.runtime ?? 'onnx';
  const dimension = options.dimension ? parseInt(options.dimension, 10) : 256;

  // 既存サーバチェック
  const existing = await checkEmbeddingHealth('127.0.0.1', port);
  if (existing) {
    console.log(`Embedding server is already running on port ${port}`);
    console.log(`  Model: ${existing.model}`);
    console.log(`  Dimension: ${existing.vectorDimension}`);
    return;
  }

  // ポート確認
  if (!(await isPortAvailable(port))) {
    throw new Error(`Port ${port} is already in use.`);
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

    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
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

  if (!proc.pid) {
    throw new Error('Failed to start embedding server process');
  }

  proc.unref();

  // readiness 待ち（初回はモデルダウンロードで時間がかかる）
  console.log('Waiting for embedding server to start (initial download may take a few minutes)...');
  const ready = await waitForEmbeddingReady('127.0.0.1', port, 120000);

  if (!ready) {
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`Embedding server did not become ready within 120s.\nCheck log: ${logPath}`);
  }

  // PIDファイル保存
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
