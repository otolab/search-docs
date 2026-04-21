/**
 * embedding stop コマンド
 */

import { readFile, unlink } from 'fs/promises';
import { isProcessAlive, killProcess } from '../../utils/process.js';
import { embeddingPidPath } from '../../utils/embedding.js';

export interface EmbeddingStopOptions {}

export async function executeEmbeddingStop(_options: EmbeddingStopOptions): Promise<void> {
  try {
    await stopEmbeddingServer();
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

async function stopEmbeddingServer(): Promise<void> {
  const pidFilePath = embeddingPidPath();

  let pidFile: { pid: number; port: number };
  try {
    const content = await readFile(pidFilePath, 'utf-8');
    pidFile = JSON.parse(content) as { pid: number; port: number };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'No embedding server PID file found.\n' +
        'The server may not be running or was started externally.'
      );
    }
    throw error;
  }

  if (!isProcessAlive(pidFile.pid)) {
    console.log(`Embedding server is not running (PID: ${pidFile.pid} not found).`);
    console.log('Cleaning up PID file...');
    await unlink(pidFilePath).catch(() => {});
    return;
  }

  console.log(`Stopping embedding server (PID: ${pidFile.pid})...`);
  await killProcess(pidFile.pid, 5000);
  await unlink(pidFilePath).catch(() => {});

  console.log('Embedding server stopped.');
}
