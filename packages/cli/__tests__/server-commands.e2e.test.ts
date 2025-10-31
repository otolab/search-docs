/**
 * E2Eテスト: CLIコマンド経由でのserverコマンドテスト
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('E2E Test: Server Commands', () => {
  let testDir: string;
  const serverPort = 24282; // テスト用ポート（e2e.test.tsと衝突回避）
  const verbose = process.env.TEST_VERBOSE === 'true';

  // CLIコマンド実行ヘルパー
  async function runCliCommand(
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const cliScript = path.join(__dirname, '../dist/index.js');

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('node', [cliScript, ...args], {
        cwd: options.cwd || testDir,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const message = data.toString();
        stdout += message;
        if (verbose) {
          console.log('[CLI stdout]', message.trim());
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const message = data.toString();
        stderr += message;
        if (verbose) {
          console.error('[CLI stderr]', message.trim());
        }
      });

      const timeoutMs = options.timeout || 30000;
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  beforeAll(async () => {
    // 一時ディレクトリ作成
    testDir = path.join(__dirname, '../../__test-temp-server-commands');
    await fs.mkdir(testDir, { recursive: true });

    // テスト用Markdownファイル作成
    const testMdPath = path.join(testDir, 'test-doc.md');
    await fs.writeFile(
      testMdPath,
      `# テストドキュメント

これはserverコマンドE2Eテスト用のドキュメントです。

## セクション1

TypeScriptで実装されています。

## セクション2

Vector検索機能をテストします。
`
    );

    // テスト用設定ファイル作成
    const configPath = path.join(testDir, '.search-docs.json');
    const config = {
      version: '1.0',
      project: {
        name: 'server-commands-e2e-test',
        root: testDir,
      },
      files: {
        include: ['**/*.md'],
        exclude: ['**/node_modules/**'],
        ignoreGitignore: false,
      },
      indexing: {
        maxTokensPerSection: 2000,
        minTokensForSplit: 100,
        maxDepth: 3,
        vectorDimension: 256,
        embeddingModel: 'cl-nagoya/ruri-v3-30m',
      },
      search: {
        defaultLimit: 10,
        maxLimit: 100,
        includeCleanOnly: false,
      },
      server: {
        host: 'localhost',
        port: serverPort,
        protocol: 'json-rpc',
      },
      storage: {
        documentsPath: '.search-docs/documents',
        indexPath: '.search-docs/index',
        cachePath: '.search-docs/cache',
      },
      watcher: {
        enabled: false,
        debounce: 1000,
        ignored: ['**/node_modules/**', '**/.git/**'],
      },
      worker: {
        enabled: false,
        interval: 5000,
        maxConcurrent: 3,
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    if (verbose) {
      console.log('[Setup] Test directory:', testDir);
      console.log('[Setup] Config:', configPath);
    }
  }, 60000);

  afterAll(async () => {
    // クリーンアップ
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      if (verbose) {
        console.log('[Cleanup] Test directory removed');
      }
    } catch (error) {
      console.error('[Cleanup] Failed:', error);
    }
  });

  it('server start でサーバを起動できる（バックグラウンド）', async () => {
    const result = await runCliCommand(['server', 'start'], {
      timeout: 60000,
    });

    // 起動成功を確認
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Server started successfully');

    // PIDファイルが作成されていることを確認
    const pidFilePath = path.join(testDir, '.search-docs/server.pid');
    const pidFileExists = await fs
      .access(pidFilePath)
      .then(() => true)
      .catch(() => false);
    expect(pidFileExists).toBe(true);

    if (verbose) {
      const pidContent = await fs.readFile(pidFilePath, 'utf-8');
      console.log('[PID File]', pidContent);
    }
  }, 60000);

  it('server status でサーバのステータスを確認できる', async () => {
    const result = await runCliCommand(['server', 'status']);

    // ステータス確認成功
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Status:\s+Running/);
    expect(result.stdout).toMatch(/PID:\s+\d+/);
    expect(result.stdout).toMatch(/Port:\s+24282/);
  }, 30000);

  it('search コマンドで検索できる', async () => {
    // まずインデックスを作成
    const indexResult = await runCliCommand([
      'search',
      'TypeScript',
      '--server',
      `http://localhost:${serverPort}`,
    ]);

    if (verbose) {
      console.log('[Search] Result:', indexResult.stdout);
    }

    // 検索成功（結果が0件でもコマンド自体は成功）
    expect(indexResult.exitCode).toBe(0);
  }, 30000);

  it('server restart でサーバを再起動できる', async () => {
    const result = await runCliCommand(['server', 'restart'], {
      timeout: 60000,
    });

    // 再起動成功
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Stopping server');
    expect(result.stdout).toContain('Starting server');

    // サーバが再起動後も動作していることを確認
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const statusResult = await runCliCommand(['server', 'status']);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/Status:\s+Running/);
  }, 60000);

  it('server stop でサーバを停止できる', async () => {
    const result = await runCliCommand(['server', 'stop']);

    // 停止成功
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Server stopped successfully');

    // PIDファイルが削除されていることを確認
    const pidFilePath = path.join(testDir, '.search-docs/server.pid');
    const pidFileExists = await fs
      .access(pidFilePath)
      .then(() => true)
      .catch(() => false);
    expect(pidFileExists).toBe(false);

    // server statusでサーバが停止していることを確認
    const statusResult = await runCliCommand(['server', 'status']);
    expect(statusResult.exitCode).toBe(1);
    expect(statusResult.stderr).toContain('Server is not running');
  }, 30000);
});
