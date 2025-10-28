/**
 * server restart コマンド
 */

import { executeServerStop } from './stop.js';
import { executeServerStart } from './start.js';

/**
 * server restart コマンドのオプション
 */
export interface ServerRestartOptions {
  config?: string;
  port?: string;
  daemon?: boolean;
  log?: string;
}

/**
 * server restart コマンドを実行
 */
export async function executeServerRestart(
  options: ServerRestartOptions
): Promise<void> {
  try {
    // 1. サーバ停止
    console.log('Stopping server...');
    await executeServerStop({ config: options.config });

    // 2. 少し待機（プロセスの完全な終了を待つ）
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 3. サーバ起動
    console.log('\nStarting server...');
    await executeServerStart(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
