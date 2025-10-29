/**
 * server stop コマンド
 */

import { readPidFile, deletePidFile } from '../../utils/pid.js';
import { isProcessAlive, killProcess } from '../../utils/process.js';
import { findProjectRoot } from '../../utils/project.js';

/**
 * server stop コマンドのオプション
 */
export interface ServerStopOptions {
  config?: string;
}

/**
 * サーバ停止の内部ロジック（process.exit()を呼ばない）
 * restart等から再利用可能
 */
export async function stopServer(options: ServerStopOptions): Promise<void> {
  // 1. プロジェクトルート決定
  const projectRoot = await findProjectRoot({
    configPath: options.config,
  });

  // 2. PIDファイル読み込み
  const pidFile = await readPidFile(projectRoot);

  if (!pidFile) {
    throw new Error(
      'Server is not running.\n' +
        'No PID file found. The server may not have been started.'
    );
  }

  // 3. プロセス生存確認
  if (!isProcessAlive(pidFile.pid)) {
    console.log(`Server is not running (PID: ${pidFile.pid} not found).`);
    console.log('Cleaning up PID file...');
    await deletePidFile(projectRoot);
    return;
  }

  // 4. プロセス停止
  console.log(`Stopping server (PID: ${pidFile.pid})...`);

  await killProcess(pidFile.pid, 5000);

  // 5. PIDファイル削除
  await deletePidFile(projectRoot);

  console.log('✓ Server stopped successfully');
}

/**
 * server stop コマンドを実行（CLIエントリポイント）
 */
export async function executeServerStop(
  options: ServerStopOptions
): Promise<void> {
  try {
    await stopServer(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
