/**
 * server stop コマンド
 */

import { ConfigLoader } from '@search-docs/types';
import { SearchDocsClient } from '@search-docs/client';
import { readPidFile, deletePidFile } from '../../utils/pid.js';
import { isProcessAlive, killProcess } from '../../utils/process.js';

/**
 * server stop コマンドのオプション
 */
export interface ServerStopOptions {
  config?: string;
  cwd?: string;
}

/**
 * サーバが停止するまで待機
 */
async function waitForServerDown(
  host: string,
  port: number,
  maxWaitMs: number = 5000
): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 200; // 200ms間隔でチェック

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // ヘルスチェックが失敗すればサーバは停止している
      const response = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });

      if (!response.ok) {
        // サーバがエラー応答を返した場合も停止とみなす
        return true;
      }

      // まだ起動中、待機を続ける
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    } catch (error) {
      // 接続エラー = サーバ停止
      return true;
    }
  }

  // タイムアウト
  return false;
}

/**
 * サーバ停止の内部ロジック（process.exit()を呼ばない）
 * restart等から再利用可能
 */
export async function stopServer(options: ServerStopOptions): Promise<void> {
  // 1. 設定読み込みとプロジェクトルート決定
  const { config, projectRoot } = await ConfigLoader.resolve({
    configPath: options.config,
    cwd: options.cwd,
  });

  const host = config.server.host;
  const port = config.server.port;
  const serverUrl = `http://${host}:${port}`;

  // 2. まずgraceful shutdownを試みる（標準の停止方法）
  console.log('Shutting down server...');

  try {
    const client = new SearchDocsClient({ baseUrl: serverUrl });

    // サーバにshutdownリクエストを送信
    await client.shutdown();

    // サーバが停止するまで待機
    const stopped = await waitForServerDown(host, port, 5000);

    if (stopped) {
      // PIDファイルを削除
      await deletePidFile(projectRoot).catch(() => {
        // PIDファイルがなくてもエラーにしない
      });

      console.log('✓ Server stopped successfully');
      return;
    }

    console.log('Graceful shutdown timeout, trying force stop...');
  } catch (error) {
    console.log(
      `Graceful shutdown failed (${(error as Error).message}), trying force stop...`
    );
  }

  // 3. Graceful shutdownが失敗した場合、PIDファイルからkillを試みる（フォールバック）
  const pidFile = await readPidFile(projectRoot);

  if (!pidFile) {
    throw new Error(
      'Server is not responding to graceful shutdown.\n' +
        'No PID file found for force stop.\n' +
        'The server may have already stopped or was started without PID file.'
    );
  }

  // プロセス生存確認
  if (!isProcessAlive(pidFile.pid)) {
    console.log(`Server is not running (PID: ${pidFile.pid} not found).`);
    console.log('Cleaning up PID file...');
    await deletePidFile(projectRoot);
    return;
  }

  // プロセスを強制停止
  console.log(`Force stopping server (PID: ${pidFile.pid})...`);
  await killProcess(pidFile.pid, 5000);

  // PIDファイル削除
  await deletePidFile(projectRoot);

  console.log('✓ Server stopped (force)');
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
