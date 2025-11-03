/**
 * CLI server start/stop 基本動作テスト
 *
 * 目的: CLIツール自体の基本動作（start/stop、PIDファイル作成/削除）を確認する
 *
 * テスト内容:
 * 1. サーバを起動
 * 2. PIDファイルが作成される
 * 3. プロセスが実行中
 * 4. サーバを停止
 * 5. プロセスが停止する
 * 6. PIDファイルが削除される
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('CLI server start/stop 基本動作', () => {
  let testDir: string;
  const cliPath = path.resolve(__dirname, '../../dist/index.js');

  beforeEach(async () => {
    // テスト用の一時ディレクトリを作成
    testDir = path.join('/tmp', `cli-server-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // 設定ファイルを作成
    const configPath = path.join(testDir, '.search-docs.json');
    const config = {
      version: '1.0',
      project: {
        name: 'cli-test-project',
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
        port: 54400, // 他のテストと被らないポート
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
  });

  afterEach(async () => {
    // PIDファイルが残っていたら、プロセスを停止
    const pidFilePath = path.join(testDir, '.search-docs', 'server.pid');
    try {
      const pidContent = await fs.readFile(pidFilePath, 'utf-8');
      const pidData = JSON.parse(pidContent);

      // プロセスが生きていたら強制終了
      try {
        process.kill(pidData.pid, 0); // プロセス存在確認
        process.kill(pidData.pid, 'SIGTERM'); // 停止
        await new Promise(resolve => setTimeout(resolve, 1000)); // 停止待機
      } catch (error) {
        // プロセスが既に停止している場合は無視
      }
    } catch (error) {
      // PIDファイルがない場合は無視
    }

    // テストディレクトリを削除
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup test directory:', error);
    }
  });

  test(
    'サーバ起動→PIDファイル作成→停止→PIDファイル削除の完全なライフサイクル',
    async () => {
      const pidFilePath = path.join(testDir, '.search-docs', 'server.pid');

      // 1. サーバを起動
      const configPath = path.join(testDir, '.search-docs.json');
      const startCommand = `node "${cliPath}" --config "${configPath}" server start`;
      await execAsync(startCommand);

      // サーバ起動を待機
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 2. PIDファイルが作成されていることを確認
      const pidFileExists = await fs
        .access(pidFilePath)
        .then(() => true)
        .catch(() => false);
      expect(pidFileExists).toBe(true);

      // 3. PIDファイルの内容を確認
      const pidContent = await fs.readFile(pidFilePath, 'utf-8');
      const pidData = JSON.parse(pidContent);

      expect(pidData).toHaveProperty('pid');
      expect(pidData).toHaveProperty('port');
      expect(pidData.port).toBe(54400);

      // 4. プロセスが実行中であることを確認
      let processExists = false;
      try {
        process.kill(pidData.pid, 0); // シグナル0で存在確認のみ
        processExists = true;
      } catch (error) {
        processExists = false;
      }
      expect(processExists).toBe(true);

      // 5. サーバを停止
      const stopCommand = `node "${cliPath}" --config "${configPath}" server stop`;
      await execAsync(stopCommand);

      // 停止完了を待機
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 6. プロセスが停止していることを確認
      let processStopped = false;
      try {
        process.kill(pidData.pid, 0);
        processStopped = false;
      } catch (error) {
        processStopped = true;
      }
      expect(processStopped).toBe(true);

      // 7. PIDファイルが削除されていることを確認
      const pidFileDeleted = await fs
        .access(pidFilePath)
        .then(() => false)
        .catch(() => true);
      expect(pidFileDeleted).toBe(true);
    },
    30000
  ); // 30秒のタイムアウト
});
