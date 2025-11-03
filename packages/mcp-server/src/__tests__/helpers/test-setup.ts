/**
 * テストヘルパー - テスト環境のセットアップとティアダウン
 */

import { MCPServiceE2ETester, createMCPTester } from '@coeiro-operator/mcp-debug';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * テスト環境のオプション
 */
export interface TestEnvironmentOptions {
  /** テストディレクトリ名のプレフィックス */
  prefix?: string;
  /** 設定ファイルを作成するか */
  createConfig?: boolean;
  /** サーバポート */
  port?: number;
  /** インデックスディレクトリを作成するか（auto-start用） */
  createIndexDir?: boolean;
}

/**
 * テスト環境
 */
export interface TestEnvironment {
  /** テストディレクトリのパス */
  testDir: string;
  /** MCPテスター */
  tester: MCPServiceE2ETester;
  /** クリーンアップ関数 */
  cleanup: () => Promise<void>;
}

/**
 * テスト環境をセットアップ
 */
export async function setupTestEnvironment(
  options: TestEnvironmentOptions = {}
): Promise<TestEnvironment> {
  const {
    prefix = 'search-docs-test',
    createConfig = false,
    port = 54321,
    createIndexDir = false,
  } = options;

  // テスト用ディレクトリを作成
  const testDir = path.join('/tmp', `${prefix}-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });

  // 設定ファイルを作成（必要な場合）
  if (createConfig) {
    const configPath = path.join(testDir, '.search-docs.json');
    const config = {
      version: '1.0',
      project: {
        name: 'test-project',
        root: '.',
      },
      files: {
        include: ['**/*.md'],
        exclude: ['**/node_modules/**'],
        ignoreGitignore: true,
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
        port,
        protocol: 'json-rpc',
      },
      storage: {
        documentsPath: '.search-docs/documents',
        indexPath: '.search-docs/index',
        cachePath: '.search-docs/cache',
      },
      worker: {
        enabled: true,
        interval: 5000,
        maxConcurrent: 3,
      },
      watcher: {
        enabled: true,
        debounceMs: 1000,
        awaitWriteFinishMs: 2000,
      },
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  // インデックスディレクトリを作成（auto-startをトリガーする場合）
  if (createIndexDir) {
    const indexPath = path.join(testDir, '.search-docs', 'index');
    await fs.mkdir(indexPath, { recursive: true });
  }

  // MCPサーバーを起動
  const serverPath = path.resolve(__dirname, '../../../dist/server.js');
  const tester = await createMCPTester({
    serverPath,
    args: ['--project-dir', testDir],
  });

  await tester.waitUntilReady();

  // クリーンアップ関数
  const cleanup = async () => {
    // サーバが起動している場合は停止
    if (tester) {
      try {
        await tester.callTool('server_stop', {});
      } catch (error) {
        // サーバが既に停止している場合はエラーを無視
        console.error('Note: server_stop failed (may already be stopped):', error);
      }

      await tester.cleanup();
    }

    // テストディレクトリを削除
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup test directory:', error);
    }
  };

  return {
    testDir,
    tester,
    cleanup,
  };
}
