/**
 * server status コマンド
 */

import { SearchDocsClient } from '@search-docs/client';
import { readPidFile } from '../../utils/pid.js';
import { isProcessAlive, checkServerHealth } from '../../utils/process.js';
import { findProjectRoot } from '../../utils/project.js';

/**
 * server status コマンドのオプション
 */
export interface ServerStatusOptions {
  config?: string;
}

/**
 * server status コマンドを実行
 */
export async function executeServerStatus(
  options: ServerStatusOptions
): Promise<void> {
  try {
    // 1. プロジェクトルート決定
    const projectRoot = await findProjectRoot({
      configPath: options.config,
    });

    // 2. PIDファイル読み込み
    const pidFile = await readPidFile(projectRoot);

    if (!pidFile) {
      console.log('Server Status: Not Running');
      console.log('  No PID file found.');
      return;
    }

    // 3. プロセス生存確認
    const processAlive = isProcessAlive(pidFile.pid);

    if (!processAlive) {
      console.log('Server Status: Not Running');
      console.log(`  PID file exists but process (PID: ${pidFile.pid}) not found.`);
      console.log('  Run \'search-docs server start\' to start the server.');
      return;
    }

    // 4. ヘルスチェック
    const healthy = await checkServerHealth(pidFile.host, pidFile.port, 3000);

    if (!healthy) {
      console.log('Server Status: Unhealthy');
      console.log(`  PID: ${pidFile.pid} (alive but not responding)`);
      console.log(`  Port: ${pidFile.port}`);
      console.log('  Health check failed.');
      return;
    }

    // 5. サーバステータス取得
    console.log('Server Status: Running');
    console.log(`  PID: ${pidFile.pid}`);
    console.log(`  Started: ${new Date(pidFile.startedAt).toLocaleString()}`);
    console.log(`  Port: ${pidFile.port}`);
    console.log(`  Config: ${pidFile.configPath}`);
    if (pidFile.logPath) {
      console.log(`  Log: ${pidFile.logPath}`);
    }

    // 6. インデックス・ワーカーステータス取得
    try {
      const client = new SearchDocsClient({
        baseUrl: `http://${pidFile.host}:${pidFile.port}`,
      });

      const status = await client.getStatus();

      console.log('\nIndex Status:');
      console.log(`  Total Documents: ${status.index.totalDocuments}`);
      console.log(`  Total Sections: ${status.index.totalSections}`);
      console.log(`  Dirty Count: ${status.index.dirtyCount}`);

      console.log('\nWorker Status:');
      console.log(`  Running: ${status.worker.running ? 'Yes' : 'No'}`);
      console.log(`  Processing: ${status.worker.processing}`);
      console.log(`  Queue: ${status.worker.queue}`);
    } catch (error) {
      console.log('\nFailed to get detailed status:', (error as Error).message);
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
