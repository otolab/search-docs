/**
 * プロセス管理ユーティリティ
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

/**
 * プロセスが生存しているか確認
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // シグナル0は実際にシグナルを送らず、プロセスの存在のみチェック
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'ESRCH') {
      // プロセスが存在しない
      return false;
    }

    if (err.code === 'EPERM') {
      // 権限がないが、プロセスは存在する
      return true;
    }

    return false;
  }
}

/**
 * プロセスを停止
 * @param pid プロセスID
 * @param timeout タイムアウト（ミリ秒）。この時間内に停止しない場合はSIGKILLを送信
 */
export async function killProcess(
  pid: number,
  timeout: number = 5000
): Promise<void> {
  // プロセスが既に停止している場合は何もしない
  if (!isProcessAlive(pid)) {
    return;
  }

  // プラットフォームに応じた停止処理
  if (process.platform === 'win32') {
    // Windows: taskkillを使用
    await killProcessWindows(pid, timeout);
  } else {
    // Unix系: SIGTERMを送信
    await killProcessUnix(pid, timeout);
  }
}

/**
 * Unix系でプロセスを停止
 */
async function killProcessUnix(pid: number, timeout: number): Promise<void> {
  // SIGTERMを送信
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    // プロセスが既に停止している可能性
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return;
    }
    throw error;
  }

  // 停止を待機
  const stopped = await waitForProcessExit(pid, timeout);

  if (!stopped) {
    // タイムアウト: SIGKILLで強制終了
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // プロセスが既に停止している可能性
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }

    // 再度待機（短時間）
    await waitForProcessExit(pid, 1000);
  }
}

/**
 * Windowsでプロセスを停止
 */
async function killProcessWindows(
  pid: number,
  timeout: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const killProcess = spawn('taskkill', [
      '/PID',
      pid.toString(),
      '/T', // サブプロセスも終了
    ]);

    const timeoutId = setTimeout(() => {
      // タイムアウト: 強制終了
      const forceKill = spawn('taskkill', [
        '/PID',
        pid.toString(),
        '/F', // 強制終了
        '/T',
      ]);

      forceKill.on('close', () => {
        resolve();
      });

      forceKill.on('error', reject);
    }, timeout);

    killProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0 || code === 128) {
        // 128: プロセスが見つからない（既に終了している）
        resolve();
      } else {
        reject(new Error(`taskkill failed with code ${code}`));
      }
    });

    killProcess.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * プロセスの終了を待機
 * @returns 指定時間内に終了した場合true、タイムアウトの場合false
 */
async function waitForProcessExit(
  pid: number,
  timeout: number
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    // 100ms待機
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

/**
 * ポートが利用可能か確認
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false); // ポート使用中
      } else {
        resolve(false); // その他のエラーも利用不可とみなす
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true); // ポート利用可能
    });

    server.listen(port);
  });
}

/**
 * サーバプロセスを起動
 */
export interface SpawnServerOptions {
  serverScript: string;
  configPath: string;
  daemon: boolean;
  logPath?: string;
}

export function spawnServer(options: SpawnServerOptions): ChildProcess {
  const args = [options.serverScript];

  const spawnOptions: {
    detached: boolean;
    stdio: 'inherit' | ['ignore', number | 'ignore', number | 'ignore'];
    env: NodeJS.ProcessEnv;
  } = {
    detached: options.daemon,
    stdio: 'inherit',
    env: {
      ...process.env,
      SEARCH_DOCS_CONFIG: options.configPath,
    },
  };

  // デーモンモードの場合、stdioをログファイルまたはignoreに設定
  if (options.daemon) {
    // 将来的にlogPathを使ってログファイルに出力する
    // 今は単純にignore
    spawnOptions.stdio = ['ignore', 'ignore', 'ignore'];
  }

  const serverProcess = spawn('node', args, spawnOptions);

  // デーモンモードの場合はunref（親プロセス終了を待たない）
  if (options.daemon) {
    serverProcess.unref();
  }

  return serverProcess;
}

/**
 * サーバのヘルスチェック
 */
export async function checkServerHealth(
  host: string,
  port: number,
  timeout: number = 3000
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as { status: string };
      return data.status === 'ok';
    }

    return false;
  } catch (_error) {
    return false;
  }
}

/**
 * サーバの起動を待機
 * ヘルスチェックが成功するまで待機
 */
export async function waitForServerStart(
  host: string,
  port: number,
  timeout: number = 30000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const healthy = await checkServerHealth(host, port, 3000);

    if (healthy) {
      return true;
    }

    // 1秒待機
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}
