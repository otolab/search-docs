/**
 * server start コマンド
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  readPidFile,
  writePidFile,
  deletePidFile,
  type PidFileContent,
} from '../../utils/pid.js';
import {
  isProcessAlive,
  isPortAvailable,
  spawnServer,
  waitForServerStart,
} from '../../utils/process.js';
import { findProjectRoot, resolveConfigPath } from '../../utils/project.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * server start コマンドのオプション
 */
export interface ServerStartOptions {
  config?: string;
  port?: string;
  daemon?: boolean;
  log?: string;
}

/**
 * サーバ起動の内部ロジック（process.exit()を呼ばない）
 * restart等から再利用可能
 */
export async function startServer(options: ServerStartOptions): Promise<void> {
    // デバッグ: optionsの内容を確認
    console.log('[DEBUG] executeServerStart options:', JSON.stringify(options, null, 2));

    // 1. プロジェクトルート決定
    const projectRoot = await findProjectRoot({
      configPath: options.config,
    });

    console.log(`Project root: ${projectRoot}`);

    // 2. 設定ファイルパス解決
    const configPath = await resolveConfigPath(projectRoot, options.config);

    console.log(`Config: ${configPath}`);

    // 3. 設定ファイル読み込み
    let config: {
      project: { name: string; root?: string };
      server: { host: string; port: number };
    };

    try {
      const configContent = readFileSync(configPath, 'utf-8');
      config = JSON.parse(configContent) as typeof config;
    } catch (_error) {
      throw new Error(
        `Failed to load config file: ${configPath}\n` +
          `Run 'search-docs config init' to create a config file.`
      );
    }

    // 4. 既存プロセスチェック
    const existingPid = await readPidFile(projectRoot);

    if (existingPid && isProcessAlive(existingPid.pid)) {
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
      console.log(
        `Found stale PID file. Previous server (PID: ${existingPid.pid}) is not running.`
      );
      await deletePidFile(projectRoot);
    }

    // 6. ポート確認
    const port = options.port ? parseInt(options.port, 10) : config.server.port;

    if (!(await isPortAvailable(port))) {
      throw new Error(
        `Port ${port} is already in use.\n` +
          `Please specify a different port with --port option.`
      );
    }

    // 7. サーバスクリプトパス
    // import.meta.resolve()でインストール環境に依存しないパス解決
    // 開発環境: packages/server/dist/index.js
    // インストール環境: node_modules/@search-docs/server/dist/index.js
    const serverModulePath = import.meta.resolve('@search-docs/server');
    const serverModuleFile = fileURLToPath(serverModulePath);
    const serverDistDir = path.dirname(serverModuleFile);
    const serverScript = path.join(serverDistDir, 'bin/server.js');

    // 8. サーバプロセス起動
    console.log(`Starting server${options.daemon ? ' (daemon mode)' : ''}...`);

    const serverProcess = spawnServer({
      serverScript,
      configPath,
      daemon: options.daemon || false,
      logPath: options.log,
    });

    if (!serverProcess.pid) {
      throw new Error('Failed to start server process');
    }

    // 9. PIDファイル作成
    // CLIモジュールのパスからpackage.jsonを解決
    // workspace環境では import.meta.resolve() が失敗することがあるため、
    // fallbackとして __dirname からの相対パスも試行
    let packageJson: { version: string };
    try {
      const cliModulePath = import.meta.resolve('@search-docs/cli');
      const cliModuleFile = fileURLToPath(cliModulePath);
      const cliPkgDir = path.dirname(path.dirname(cliModuleFile)); // dist/index.js → dist → cli/
      const packageJsonPath = path.join(cliPkgDir, 'package.json');
      packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
    } catch (_error) {
      // Fallback: __dirname から相対的に取得 (開発環境用)
      // dist/commands/server/ → ../../../package.json
      const fallbackPath = path.join(__dirname, '../../../package.json');
      packageJson = JSON.parse(readFileSync(fallbackPath, 'utf-8')) as { version: string };
    }

    const pidFileContent: PidFileContent = {
      pid: serverProcess.pid,
      startedAt: new Date().toISOString(),
      projectRoot,
      projectName: config.project.name,
      host: config.server.host,
      port,
      configPath,
      logPath: options.log,
      version: packageJson.version,
      nodeVersion: process.version,
    };

    await writePidFile(pidFileContent);

    // 10. 起動確認
    if (options.daemon) {
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
        // 起動失敗、PIDファイル削除
        await deletePidFile(projectRoot);
        throw new Error(
          'Server startup timeout. Check logs for details.'
        );
      }
    } else {
      // フォアグラウンドモードの場合は起動メッセージのみ
      console.log(`Server starting (PID: ${serverProcess.pid})...`);
      console.log('Press Ctrl+C to stop.');

      // プロセスの終了を待つ
      await new Promise<void>((resolve) => {
        serverProcess.on('exit', () => {
          resolve();
        });
      });

      // 終了時にPIDファイル削除
      await deletePidFile(projectRoot);
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
