/**
 * サーバ自動起動マネージャー
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

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
      const cliPackage = await import.meta.resolve('@search-docs/cli');

      // file:// プロトコルを削除してファイルパスに変換
      const cliPackagePath = cliPackage.replace(/^file:\/\//, '');

      // パッケージディレクトリを取得
      const cliDir = path.dirname(cliPackagePath);

      // dist/index.jsを探す
      const cliEntryPoint = path.join(cliDir, 'dist', 'index.js');

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
   * サーバを起動
   */
  async startServer(projectDir: string, port: number, configPath?: string): Promise<void> {
    console.error('[mcp-server] Starting search-docs server...');

    try {
      // CLIのエントリポイントを解決
      const cliPath = await this.resolveCliPath();
      console.error(`[mcp-server] CLI path resolved: ${cliPath}`);

      // サーバ起動コマンドを構築
      const args = ['server', 'start', '--foreground', '--port', port.toString()];

      if (configPath) {
        args.push('--config', configPath);
      }

      // サーバを起動
      const serverProcess = spawn(
        'node',
        [cliPath, ...args],
        {
          cwd: projectDir, // プロジェクトディレクトリで実行
          stdio: ['ignore', 'pipe', 'pipe'], // stdin無視, stdout/stderrキャプチャ
          detached: false, // MCP終了時にサーバも終了
        }
      );

      // エラーハンドリング
      serverProcess.on('error', (error) => {
        console.error(`[mcp-server] Server process error: ${error.message}`);
      });

      // 標準出力をログ
      serverProcess.stdout?.on('data', (data) => {
        console.error(`[server] ${data.toString().trim()}`);
      });

      // 標準エラー出力をログ
      serverProcess.stderr?.on('data', (data) => {
        console.error(`[server] ${data.toString().trim()}`);
      });

      // プロセス終了時
      serverProcess.on('exit', (code, signal) => {
        console.error(`[mcp-server] Server process exited: code=${code}, signal=${signal}`);
        this.serverProcess = null;
      });

      this.serverProcess = {
        process: serverProcess,
        port,
      };

      // サーバの起動を待つ（簡易的に2秒待機）
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.error('[mcp-server] Server started successfully');
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
