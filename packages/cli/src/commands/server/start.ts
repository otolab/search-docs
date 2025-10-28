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
 * server start コマンドを実行
 */
export async function executeServerStart(
  options: ServerStartOptions
): Promise<void> {
  try {
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
    // CLIパッケージから見たserverパッケージのパス
    const serverScript = path.join(
      __dirname,
      '../../../../server/dist/bin/server.js'
    );

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
    const packageJsonPath = path.join(__dirname, '../../../package.json');
    const packageJson = JSON.parse(
      readFileSync(packageJsonPath, 'utf-8')
    ) as { version: string };

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
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
