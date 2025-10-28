/**
 * E2Eテスト: CLI → Server → DB-Engine の統合テスト
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SearchDocsClient } from '@search-docs/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('E2E Test: CLI → Server → DB', () => {
  let serverProcess: ChildProcess | null = null;
  let testDir: string;
  const serverPort = 24281; // テスト用ポート（デフォルトと衝突回避）

  beforeAll(async () => {
    // 一時ディレクトリ作成
    testDir = path.join(__dirname, '../../__test-temp');
    await fs.mkdir(testDir, { recursive: true });

    // テスト用Markdownファイル作成
    const testMdPath = path.join(testDir, 'test-doc.md');
    await fs.writeFile(
      testMdPath,
      `# テストドキュメント

これはE2Eテスト用のドキュメントです。

## セクション1

TypeScriptで実装されています。

## セクション2

Vector検索機能をテストします。
`
    );

    // テスト用設定ファイル作成
    const configPath = path.join(testDir, 'search-docs.json');
    const config = {
      version: '1.0',
      project: {
        name: 'e2e-test',
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

    // サーバ起動（ビルド済みのJSを実行）
    const serverScript = path.join(__dirname, '../../server/dist/bin/server.js');

    console.log('[E2E] Starting server...');
    console.log('  Server script:', serverScript);
    console.log('  Config:', configPath);

    serverProcess = spawn('node', [serverScript], {
      cwd: testDir,
      env: {
        ...process.env,
        SEARCH_DOCS_CONFIG: configPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // サーバの起動を待つ
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 30000);

      serverProcess!.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        console.log('[Server]', data.toString().trim());
        if (output.includes('Server started successfully')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess!.stderr?.on('data', (data: Buffer) => {
        console.error('[Server Error]', data.toString().trim());
      });

      serverProcess!.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      serverProcess!.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });

    console.log('[E2E] Server started successfully');

    // サーバが完全に起動するまで少し待つ
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // テストドキュメントをインデックス
    const client = new SearchDocsClient({ baseUrl: `http://localhost:${serverPort}` });
    await client.indexDocument({ path: testMdPath });

    console.log('[E2E] Test document indexed');
  }, 60000); // 60秒タイムアウト

  afterAll(async () => {
    // サーバ停止
    if (serverProcess) {
      console.log('[E2E] Stopping server...');
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
      serverProcess = null;
    }

    // クリーンアップ
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      console.log('[E2E] Cleanup completed');
    } catch (error) {
      console.error('[E2E] Cleanup failed:', error);
    }
  });

  it('CLIからサーバに接続して検索できる', async () => {
    const client = new SearchDocsClient({ baseUrl: `http://localhost:${serverPort}` });

    // 検索実行
    const response = await client.search({
      query: 'TypeScript',
      options: {
        limit: 10,
      },
    });

    // 検証
    expect(response).toBeDefined();
    expect(response.results).toBeDefined();
    expect(Array.isArray(response.results)).toBe(true);
    expect(response.total).toBeGreaterThanOrEqual(0);
    expect(typeof response.took).toBe('number');

    console.log(`[E2E] Search results: ${response.total} hits in ${response.took}ms`);
  });

  it('検索結果が正しい構造を持つ', async () => {
    const client = new SearchDocsClient({ baseUrl: `http://localhost:${serverPort}` });

    const response = await client.search({
      query: 'Vector検索',
      options: {
        limit: 5,
      },
    });

    if (response.results.length > 0) {
      const firstResult = response.results[0];
      expect(firstResult).toHaveProperty('id');
      expect(firstResult).toHaveProperty('documentPath');
      expect(firstResult).toHaveProperty('heading');
      expect(firstResult).toHaveProperty('depth');
      expect(firstResult).toHaveProperty('content');
      expect(firstResult).toHaveProperty('score');
      expect(firstResult).toHaveProperty('isDirty');
      expect(firstResult).toHaveProperty('tokenCount');
    }
  });
});
