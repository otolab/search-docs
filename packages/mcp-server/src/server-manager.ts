/**
 * サーバ自動起動マネージャー
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SearchDocsClient } from '@search-docs/client';

/**
 * サーバプロセス情報
 */
interface ServerProcess {
  process: ChildProcess;
  port: number;
}

/**
 * サーバマネージャー
 */
export class ServerManager {
  private serverProcess: ServerProcess | null = null;

  /**
   * @search-docs/cliパッケージのエントリポイントを解決
   */
  private async resolveCliPath(): Promise<string> {
    try {
      // import.meta.resolve()でパスを解決
      // これはパッケージのエントリポイント（package.jsonのmainフィールド）を返す
      const cliPackage = import.meta.resolve('@search-docs/cli');

      // file:// プロトコルを削除してファイルパスに変換
      const cliEntryPoint = cliPackage.replace(/^file:\/\//, '');

      // ファイルが存在するか確認
      await fs.access(cliEntryPoint);

      return cliEntryPoint;
    } catch (error) {
      throw new Error(
        `Failed to resolve @search-docs/cli package: ${(error as Error).message}\n` +
        'Please ensure @search-docs/cli is installed.'
      );
    }
  }

  /**
   * サーバを起動（デーモンモード）
   */
  async startServer(projectDir: string, port: number, configPath?: string): Promise<void> {
    console.error('[mcp-server] ========================================');
    console.error('[mcp-server] Starting search-docs server...');
    console.error('[mcp-server] Input parameters:');
    console.error(`[mcp-server]   - projectDir: ${projectDir}`);
    console.error(`[mcp-server]   - port: ${port}`);
    console.error(`[mcp-server]   - configPath: ${configPath || '(not provided)'}`);

    try {
      // CLIのエントリポイントを解決
      const cliPath = await this.resolveCliPath();
      console.error(`[mcp-server] CLI path resolved: ${cliPath}`);

      // サーバ起動コマンドを構築（デーモンモード）
      const args = ['server', 'start', '--port', port.toString()];

      if (configPath) {
        args.push('--config', configPath);
      }

      console.error('[mcp-server] Spawn parameters:');
      console.error(`[mcp-server]   - command: node`);
      console.error(`[mcp-server]   - args: ${JSON.stringify([cliPath, ...args])}`);
      console.error(`[mcp-server]   - cwd: ${projectDir}`);
      console.error(`[mcp-server]   - stdio: ['ignore', 'pipe', 'pipe']`);
      console.error(`[mcp-server]   - detached: false`);

      // サーバを起動（デーモンモード）
      const serverProcess = spawn(
        'node',
        [cliPath, ...args],
        {
          cwd: projectDir, // プロジェクトディレクトリで実行
          stdio: ['ignore', 'pipe', 'pipe'], // stdin無視, stdout/stderrキャプチャ
          detached: false,
        }
      );

      console.error(`[mcp-server] Process spawned with PID: ${serverProcess.pid || '(unknown)'}`);

      // エラーハンドリング
      serverProcess.on('error', (error) => {
        console.error(`[mcp-server] Server process error: ${error.message}`);
      });

      // 標準出力をログ
      serverProcess.stdout?.on('data', (data: Buffer) => {
        console.error(`[server] ${data.toString().trim()}`);
      });

      // 標準エラー出力をログ
      serverProcess.stderr?.on('data', (data: Buffer) => {
        console.error(`[server] ${data.toString().trim()}`);
      });

      // プロセス終了時
      serverProcess.on('exit', (code, signal) => {
        console.error(`[mcp-server] Server launcher exited: code=${code}, signal=${signal}`);
      });

      // デーモンモードなので、起動プロセスは即座に終了する
      // 実際のサーバプロセスは別プロセスとして起動される
      this.serverProcess = {
        process: serverProcess,
        port,
      };

      // デーモンモードでは起動プロセスが即座に終了するため、
      // 実際のサーバプロセスが起動完了するまで待機する
      console.error('[mcp-server] Waiting for server to start...');

      // サーバのヘルスチェックを行う（最大30秒待機）
      const serverUrl = `http://localhost:${port}`;
      const client = new SearchDocsClient({ baseUrl: serverUrl });
      const maxWaitTime = 30000; // 30秒
      const checkInterval = 1000; // 1秒
      let waited = 0;
      let serverReady = false;

      console.error(`[mcp-server] Health check target: ${serverUrl}`);
      console.error(`[mcp-server] Max wait time: ${maxWaitTime}ms, check interval: ${checkInterval}ms`);

      while (waited < maxWaitTime) {
        try {
          console.error(`[mcp-server] Health check attempt (waited: ${waited}ms)...`);
          await client.healthCheck();
          serverReady = true;
          console.error('[mcp-server] ✓ Server is ready (health check passed)');
          break;
        } catch (error) {
          // サーバがまだ起動していない、待機を続ける
          console.error(`[mcp-server]   Health check failed: ${(error as Error).message}`);
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waited += checkInterval;
        }
      }

      if (!serverReady) {
        console.error('[mcp-server] ✗ Health check timeout after 30 seconds');
        throw new Error('Server failed to start within 30 seconds');
      }

      // PIDファイルの作成を確認
      const pidFilePath = path.join(projectDir, '.search-docs', 'server.pid');
      console.error(`[mcp-server] Checking PID file at: ${pidFilePath}`);
      try {
        await fs.access(pidFilePath);
        const pidContent = await fs.readFile(pidFilePath, 'utf-8');
        console.error('[mcp-server] ✓ PID file confirmed');
        console.error(`[mcp-server]   PID file content: ${pidContent.substring(0, 200)}...`);
      } catch (error) {
        console.error(`[mcp-server] ✗ Warning: PID file not found: ${(error as Error).message}`);
      }

      console.error('[mcp-server] Server started successfully (daemon mode)');
      console.error('[mcp-server] ========================================');
    } catch (error) {
      throw new Error(`Failed to start server: ${(error as Error).message}`);
    }
  }

  /**
   * サーバを停止
   */
  stopServer(): void {
    if (this.serverProcess) {
      console.error('[mcp-server] Stopping server...');
      this.serverProcess.process.kill('SIGTERM');
      this.serverProcess = null;
    }
  }

  /**
   * クリーンアップ（プロセス終了時）
   */
  cleanup(): void {
    this.stopServer();
  }
}
