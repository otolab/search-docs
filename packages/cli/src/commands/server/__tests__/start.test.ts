/**
 * server start コマンドのテスト
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { startServer } from '../start.js';
import { writePidFile, deletePidFile } from '../../../utils/pid.js';
import { ConfigLoader } from '@search-docs/types';

describe('server start - ログ記録', () => {
  let testDir: string;
  let configPath: string;
  let logPath: string;

  beforeEach(async () => {
    // 各テストで独立したディレクトリを作成
    testDir = path.join(
      '/tmp',
      `.test-server-start-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    configPath = path.join(testDir, '.search-docs.json');
    logPath = path.join(testDir, '.search-docs', 'server.log');

    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(path.join(testDir, '.search-docs'), { recursive: true });

    // テスト用設定ファイルを作成
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
        port: 50000 + Math.floor(Math.random() * 10000), // ランダムポート
        protocol: 'json-rpc' as const,
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
  });

  afterEach(async () => {
    // PIDファイルを削除
    try {
      await deletePidFile(testDir);
    } catch {
      // ignore
    }

    // テストディレクトリを削除
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('PIDファイル競合時にエラーメッセージが表示される', async () => {
    // 既存のPIDファイルを作成（現在のプロセスIDを使用 = 確実に生きている）
    await writePidFile({
      pid: process.pid, // 現在のテストプロセス自身のPID
      startedAt: new Date().toISOString(),
      projectRoot: testDir,
      projectName: 'test-project',
      host: 'localhost',
      port: 24280,
      configPath,
      version: '1.0.0',
      nodeVersion: process.version,
    });

    // サーバ起動を試みる（失敗するはず）
    try {
      await startServer({
        config: configPath,
        log: logPath,
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      // エラーメッセージを確認
      expect((error as Error).message).toContain('already running');
    }
  });

  it('ポート競合時にエラーメッセージが表示される', async () => {
    // 既存のPIDファイルを削除（あれば）
    try {
      await deletePidFile(testDir);
    } catch {
      // ignore
    }

    // 設定ファイルを読み込んでポート番号を取得
    const { config } = await ConfigLoader.resolve({
      configPath,
      requireConfig: true,
    });

    // テスト用のポートを使用中にする
    const net = await import('net');
    const testServer = net.createServer();

    await new Promise<void>((resolve) => {
      testServer.listen(config.server.port, () => {
        resolve();
      });
    });

    try {
      // サーバ起動を試みる（ポート競合で失敗するはず）
      await startServer({
        config: configPath,
        log: logPath,
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      // エラーメッセージを確認
      expect((error as Error).message).toContain('already in use');
    } finally {
      // テストサーバを停止
      testServer.close();
    }
  });

  it('ログファイルが作成される', async () => {
    // 既存のPIDファイルを削除
    try {
      await deletePidFile(testDir);
    } catch {
      // ignore
    }

    // ポート競合を意図的に発生させてエラーケースをテスト
    const { config } = await ConfigLoader.resolve({
      configPath,
      requireConfig: true,
    });

    const net = await import('net');
    const testServer = net.createServer();

    await new Promise<void>((resolve) => {
      testServer.listen(config.server.port, () => {
        resolve();
      });
    });

    try {
      await startServer({
        config: configPath,
        log: logPath,
      });
    } catch (error) {
      // エラーは期待通り
    } finally {
      testServer.close();
    }

    // ログファイルが存在するか確認
    const logExists = await fs
      .access(logPath)
      .then(() => true)
      .catch(() => false);

    expect(logExists).toBe(true);

    if (logExists) {
      // ログの内容を確認
      const logContent = await fs.readFile(logPath, 'utf-8');
      // ログストリームが開かれた後のメッセージを確認
      expect(logContent).toContain('Log file');
      expect(logContent).toContain('Checking');
      expect(logContent).toContain('ERROR');
    }
  });
});
