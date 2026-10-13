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
 * detached 起動したプロセスとその子プロセスを停止し、OSから終了が確認できるまで待つ。
 * Unix系では専用プロセスグループ、Windowsでは taskkill /T を使う。
 */
export async function killProcessTree(pid: number, timeout: number = 5000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    await killProcessWindows(pid, timeout);
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, timeout)) return;

  signalProcessGroup(pid, 'SIGKILL');
  if (!(await waitForProcessGroupExit(pid, 1000))) {
    throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      // The group leader can exit before its child. Fall back to the leader
      // only when there is no group left to signal.
      if (isProcessAlive(pid)) {
        process.kill(pid, signal);
      }
      return;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(pgid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      // EPERM means the group still exists but cannot be inspected.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
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
  embeddingReadyTimeoutMs?: number;
}

export function spawnServer(options: SpawnServerOptions): ChildProcess {
  const args = [options.serverScript];

  const env = { ...process.env };

  // configPathが指定されている場合のみ環境変数を設定
  if (options.configPath) {
    env.SEARCH_DOCS_CONFIG = options.configPath;
  }
  if (options.embeddingReadyTimeoutMs !== undefined) {
    env.SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS = String(options.embeddingReadyTimeoutMs);
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
  timeout: number = 3000,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortRequest, { once: true });
  try {
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`http://${host}:${port}/health`, {
        signal: controller.signal,
      });

      if (!response.ok) return false;
      const data = (await response.json()) as { status: string };
      return data.status === 'ok';
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (_error) {
    return false;
  } finally {
    signal?.removeEventListener('abort', abortRequest);
  }
}

function serverProcessExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const exitDetails = [
    code === null ? null : `exit code ${code}`,
    signal === null ? null : `signal ${signal}`,
  ].filter((detail): detail is string => detail !== null).join(', ');
  return new Error(
    `Server process exited before becoming healthy${exitDetails ? ` (${exitDetails})` : ''}. ` +
      'Check server logs for details.',
  );
}

/**
 * サーバの起動を待機
 * ヘルスチェックが成功するまで待機。起動プロセスを指定した場合は、
 * timeoutより前のプロセス終了・spawn errorを待ち続けず呼び出し元へ返す。
 */
export async function waitForServerStart(
  host: string,
  port: number,
  timeout: number = 30000,
  serverProcess?: ChildProcess,
): Promise<boolean> {
  const startTime = Date.now();
  const controller = new AbortController();
  const pollForHealth = async (): Promise<boolean> => {
    while (!controller.signal.aborted && Date.now() - startTime < timeout) {
      const healthy = await checkServerHealth(host, port, 3000, controller.signal);
      if (healthy) return true;
      if (controller.signal.aborted) return false;

      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          controller.signal.removeEventListener('abort', abortDelay);
          resolve();
        };
        const abortDelay = () => {
          clearTimeout(timer);
          done();
        };
        timer = setTimeout(done, 1000);
        controller.signal.addEventListener('abort', abortDelay, { once: true });
      });
    }
    return false;
  };

  if (!serverProcess) {
    return pollForHealth();
  }

  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    throw serverProcessExitError(serverProcess.exitCode, serverProcess.signalCode);
  }

  let onError: ((error: Error) => void) | undefined;
  let onExit:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  const processFailure = new Promise<never>((_resolve, reject) => {
    onError = (error) => {
      reject(new Error(`Server process failed before becoming healthy: ${error.message}`, {
        cause: error,
      }));
    };
    onExit = (code, signal) => reject(serverProcessExitError(code, signal));
    serverProcess.once('error', onError);
    serverProcess.once('exit', onExit);
  });
  // Check again after registering listeners to cover exit between the first
  // state check and listener registration without starting a health request.
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    if (onError) serverProcess.removeListener('error', onError);
    if (onExit) serverProcess.removeListener('exit', onExit);
    throw serverProcessExitError(serverProcess.exitCode, serverProcess.signalCode);
  }

  try {
    return await Promise.race([pollForHealth(), processFailure]);
  } finally {
    controller.abort();
    if (onError) serverProcess.removeListener('error', onError);
    if (onExit) serverProcess.removeListener('exit', onExit);
  }
}
