/**
 * embedding status コマンド
 */

import { readFile } from 'fs/promises';
import { isProcessAlive } from '../../utils/process.js';
import { checkEmbeddingHealth, embeddingPidPath } from '../../utils/embedding.js';

export interface EmbeddingStatusOptions {
  port?: string;
}

interface PidFileInfo {
  pid: number;
  port: number;
  startedAt: string;
  model: string;
  dimension: number;
  logPath?: string;
}

export async function executeEmbeddingStatus(options: EmbeddingStatusOptions): Promise<void> {
  try {
    await showEmbeddingStatus(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

async function showEmbeddingStatus(options: EmbeddingStatusOptions): Promise<void> {
  const port = options.port ? parseInt(options.port, 10) : 24281;

  // PIDファイル確認
  const pidFilePath = embeddingPidPath();
  let pidFile: PidFileInfo | null = null;

  try {
    const content = await readFile(pidFilePath, 'utf-8');
    pidFile = JSON.parse(content) as PidFileInfo;
  } catch { /* no pid file */ }

  // ヘルスチェック
  const health = await checkEmbeddingHealth('localhost', port);

  if (!health) {
    if (pidFile && !isProcessAlive(pidFile.pid)) {
      console.log('Embedding server: Not running (stale PID file)');
    } else {
      console.log(`Embedding server: Not running (port ${port})`);
    }
    console.log('\nTo start: search-docs embedding start');
    process.exit(1);
  }

  console.log('Embedding server: Running');
  console.log(`  Model: ${health.model}`);
  console.log(`  Dimension: ${health.vectorDimension}`);
  console.log(`  URL: http://localhost:${port}`);

  if (pidFile && isProcessAlive(pidFile.pid)) {
    console.log(`  PID: ${pidFile.pid}`);
    console.log(`  Started: ${new Date(pidFile.startedAt).toLocaleString()}`);
    if (pidFile.logPath) {
      console.log(`  Log: ${pidFile.logPath}`);
    }
  }
}
