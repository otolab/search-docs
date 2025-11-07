/**
 * server start コマンド
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, type WriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { ConfigLoader } from '@search-docs/types';
import {
  readPidFile,
  deletePidFile,
} from '../../utils/pid.js';
import {
  isProcessAlive,
  isPortAvailable,
  spawnServer,
  waitForServerStart,
} from '../../utils/process.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * server start コマンドのオプション
 */
export interface ServerStartOptions {
  config?: string;
  port?: string;
  foreground?: boolean;
  log?: string;
}

/**
 * サーバ起動の内部ロジック（process.exit()を呼ばない）
 * restart等から再利用可能
 */
export async function startServer(options: ServerStartOptions): Promise<void> {
    // デバッグ: optionsの内容を確認
    console.log('[DEBUG] executeServerStart options:', JSON.stringify(options, null, 2));

    // 0. ログストリームを早期に開く（エラーが起きても記録できるように）
    let logStream: WriteStream | null = null;
    let logPath: string | null = null;

    const log = (message: string) => {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] ${message}`;
      console.log(message); // コンソールにも出力
      if (logStream) {
        logStream.write(logMessage + '\n');
      }
    };

    try {
      // 1. 設定読み込みとプロジェクトルート決定
      log('Server start requested');
      log('Loading configuration...');

      const { config, configPath, projectRoot } = await ConfigLoader.resolve({
        configPath: options.config,
        requireConfig: true,
      });

      log(`Project root: ${projectRoot}`);
      log(`Config: ${configPath || 'default config'}`);

      // ログファイルパスを決定
      logPath = options.log || path.join(projectRoot, '.search-docs', 'server.log');

      // ログディレクトリを作成
      const logDir = path.dirname(logPath);
      await mkdir(logDir, { recursive: true });

      // ログストリームを開く
      logStream = createWriteStream(logPath, { flags: 'a' });
      log(`Log file: ${logPath}`);

      // 4. 既存プロセスチェック
      log('Checking for existing server...');
      const existingPid = await readPidFile(projectRoot);

      if (existingPid && isProcessAlive(existingPid.pid)) {
        log(`ERROR: Server already running (PID: ${existingPid.pid})`);
        throw new Error(
          `Server is already running for this project.\n` +
            `  PID: ${existingPid.pid}\n` +
            `  Started: ${existingPid.startedAt}\n` +
            `  Port: ${existingPid.port}\n` +
            `\n` +
            `To stop the server, run: search-docs server stop`
        );
      }

      // 5. 古いPIDファイル削除
      if (existingPid) {
        log(
          `Found stale PID file. Previous server (PID: ${existingPid.pid}) is not running.`
        );
        await deletePidFile(projectRoot);
      }

      // 6. ポート確認
      const port = options.port ? parseInt(options.port, 10) : config.server.port;
      log(`Checking port ${port}...`);

      if (!(await isPortAvailable(port))) {
        log(`ERROR: Port ${port} is already in use`);
        throw new Error(
          `Port ${port} is already in use.\n` +
            `Please specify a different port with --port option.`
        );
      }

      log(`Port ${port} is available`);


      // 7. サーバスクリプトパス
      log('Resolving server script path...');
      // import.meta.resolve()でインストール環境に依存しないパス解決
      // 開発環境: packages/server/dist/index.js
      // インストール環境: node_modules/@search-docs/server/dist/index.js
      const serverModulePath = import.meta.resolve('@search-docs/server');
      const serverModuleFile = fileURLToPath(serverModulePath);
      const serverDistDir = path.dirname(serverModuleFile);
      const serverScript = path.join(serverDistDir, 'bin/server.js');
      log(`Server script: ${serverScript}`);

      // 8. サーバプロセス起動
      const isDaemon = !options.foreground;  // foreground が false ならデーモン
      log(`Starting server${isDaemon ? ' (daemon mode)' : ' (foreground mode)'}...`);

      const serverProcess = spawnServer({
        serverScript,
        configPath,
        daemon: isDaemon,
        logPath,
      });

      if (!serverProcess.pid) {
        log('ERROR: Failed to start server process');
        throw new Error('Failed to start server process');
      }

      log(`Server process spawned (PID: ${serverProcess.pid})`);
      log('Note: Server will create PID file after initialization');

      // 9. 起動確認
    if (isDaemon) {
      // デーモンモードの場合はヘルスチェックで確認
      console.log('Waiting for server to start...');

      const started = await waitForServerStart(
        config.server.host,
        port,
        30000
      );

      if (started) {
        console.log(`✓ Server started successfully (PID: ${serverProcess.pid})`);
        console.log(`  - Project: ${config.project.name}`);
        console.log(`  - Port: ${port}`);
        console.log(
          `  - Endpoint: http://${config.server.host}:${port}/rpc`
        );
      } else {
        // 起動失敗、プロセスをkill
        // サーバプロセスがSIGTERMハンドラでPIDファイルを削除する
        log(`ERROR: Server startup timeout, killing process ${serverProcess.pid}`);
        if (serverProcess.pid) {
          try {
            process.kill(serverProcess.pid, 'SIGTERM');
            log('Sent SIGTERM, waiting 2s for graceful shutdown...');
            await new Promise(resolve => setTimeout(resolve, 2000));

            // プロセスがまだ生きていたら強制終了
            if (isProcessAlive(serverProcess.pid)) {
              log('Process still alive, sending SIGKILL...');
              process.kill(serverProcess.pid, 'SIGKILL');
            }
          } catch (killError) {
            log(`Failed to kill process: ${(killError as Error).message}`);
          }
        }
        throw new Error(
          'Server startup timeout. Check logs for details.'
        );
      }
      } else {
        // フォアグラウンドモードの場合は起動メッセージのみ
        log(`Server starting (PID: ${serverProcess.pid})...`);
        log('Press Ctrl+C to stop.');

        // プロセスの終了を待つ
        await new Promise<void>((resolve) => {
          serverProcess.on('exit', () => {
            resolve();
          });
        });

        // 終了時のメッセージ（PIDファイルはサーバが削除）
        log('Server stopped');
      }

      log('Server startup completed successfully');
    } catch (error) {
      // エラーをログに記録
      const errorMessage = (error as Error).message;
      log(`ERROR: ${errorMessage}`);

      // ログファイルの場所をユーザーに通知
      if (logPath) {
        console.error(`\nCheck log file for details: ${logPath}`);
      }

      throw error;
    } finally {
      // ログストリームをクローズ
      if (logStream) {
        logStream.end();
      }
    }
}

/**
 * server start コマンドを実行（CLIエントリポイント）
 */
export async function executeServerStart(
  options: ServerStartOptions
): Promise<void> {
  try {
    await startServer(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
