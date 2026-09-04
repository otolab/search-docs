/**
 * プロセス管理ユーティリティ
 */

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
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
  timeout: number = 5000,
  force: boolean = false,
): Promise<void> {
  // プロセスが既に停止している場合は何もしない
  if (!isProcessAlive(pid)) {
    return;
  }

  if (force) {
    await forceKillProcess(pid);
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
 * プロセスをSIGKILL/taskkill /Fで直ちに停止する。
 * 通常のkillProcessがSIGTERMから段階的に停止するのに対し、CLIの
 * `embedding stop --force`で明示的に利用する。
 */
export async function forceKillProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;

  if (process.platform === 'win32') {
    await killProcessWindows(pid, 0, true);
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }

  const stopped = await waitForProcessExit(pid, 1000);
  if (!stopped) {
    throw new Error(`Process ${pid} did not exit after SIGKILL`);
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
  timeout: number,
  force: boolean = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const killProcess = spawn('taskkill', [
      '/PID',
      pid.toString(),
      ...(force ? ['/F'] : []),
      '/T', // サブプロセスも終了
    ]);

    if (force) {
      killProcess.on('close', (code) => {
        if (code === 0 || code === 128) resolve();
        else reject(new Error(`taskkill failed with code ${code}`));
      });
      killProcess.on('error', reject);
      return;
    }

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
  const canBind = (host: string): Promise<boolean> => new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false); // ポート使用中
      } else if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
        // IPv6が無効なホストでは、そのアドレスだけを理由にポート使用中とは扱わない。
        resolve(true);
      } else {
        resolve(false); // その他のエラーも利用不可とみなす
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true); // ポート利用可能
    });

    server.listen(port, host);
  });

  // IPv4/IPv6のどちらかでLISTENしているプロセスも検出する。
  if (!(await canBind('127.0.0.1'))) return false;
  return canBind('::1');
}

export interface ListeningProcess {
  pid: number;
  command?: string;
}

function execText(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function commandForProcess(pid: number): string | undefined {
  const command = execText('ps', ['-p', String(pid), '-o', 'command=']);
  return command || undefined;
}

/**
 * 指定ポートをLISTENしているプロセスを可能な範囲で取得する。
 * macOS/Linuxではlsofを優先し、利用できない環境ではss/netstatへフォールバックする。
 * OSや権限によって所有PIDが取得できない場合はnullを返す。
 */
export function getListeningProcess(port: number): ListeningProcess | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  if (process.platform === 'win32') {
    const output = execText('netstat', ['-ano', '-p', 'tcp']);
    if (!output) return null;
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
      const localAddress = columns[1];
      const state = columns[3].toUpperCase();
      if (state !== 'LISTENING' || !localAddress.endsWith(`:${port}`)) continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return { pid, command: commandForProcess(pid) };
    }
    return null;
  }

  const lsof = execText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (lsof) {
    const pid = Number(lsof.split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return { pid, command: commandForProcess(pid) };
  }

  const ss = execText('ss', ['-ltnp']);
  if (ss) {
    for (const line of ss.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\n`)) continue;
      const match = line.match(/pid=(\d+)/);
      if (match) {
        const pid = Number(match[1]);
        return { pid, command: commandForProcess(pid) };
      }
    }
  }

  const netstat = execText('netstat', ['-ltnp']);
  if (netstat) {
    for (const line of netstat.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\n`)) continue;
      const match = line.match(/\s(\d+)\/[^\s]+\s*$/);
      if (match) {
        const pid = Number(match[1]);
        return { pid, command: commandForProcess(pid) };
      }
    }
  }

  return null;
}

/** 別名。呼び出し側ではポート所有者という意味を明確にできる。 */
export const getPortOwner = getListeningProcess;

/**
 * サーバプロセスを起動
 */
export interface SpawnServerOptions {
  serverScript: string;
  configPath?: string | null;
  daemon: boolean;
  logPath?: string;
  projectRoot?: string;
}

export function spawnServer(options: SpawnServerOptions): ChildProcess {
  const args = [options.serverScript];

  const env = { ...process.env };

  // configPathが指定されている場合のみ環境変数を設定
  if (options.configPath) {
    env.SEARCH_DOCS_CONFIG = options.configPath;
  }

  const spawnOptions: SpawnOptions = {
    detached: options.daemon,
    stdio: 'inherit',
    env,
    // プロジェクトルートを作業ディレクトリとして設定（サーバがprocess.cwd()から設定を読み込むため）
    cwd: options.projectRoot,
  };

  // デーモンモードの場合、stdioをignoreに設定
  // ログ出力はサーバプロセス側のRotatingWriteStreamが管理する
  if (options.daemon) {
    spawnOptions.stdio = ['ignore', 'ignore', 'ignore'];

    // ログパスをサーバプロセスに環境変数で伝達
    if (options.logPath) {
      env.SEARCH_DOCS_LOG_PATH = options.logPath;
    }
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
