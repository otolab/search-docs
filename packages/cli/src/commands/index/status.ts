/**
 * index status コマンド
 */

import { SearchDocsClient } from '@search-docs/client';

/**
 * index status コマンドのオプション
 */
export interface IndexStatusOptions {
  server?: string;
  format?: 'text' | 'json';
}

/**
 * index status コマンドを実行
 */
export async function executeIndexStatus(
  options: IndexStatusOptions
): Promise<void> {
  try {
    const serverUrl = options.server || 'http://localhost:24280';
    const client = new SearchDocsClient({ baseUrl: serverUrl });

    const status = await client.getStatus();

    if (options.format === 'json') {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    // テキスト形式で出力
    console.log('Index Status');
    console.log('━'.repeat(40));
    console.log();
    console.log('Server:');
    console.log(`  Version:    ${status.server.version}`);
    console.log(`  Uptime:     ${formatUptime(status.server.uptime)}`);
    console.log(`  PID:        ${status.server.pid}`);
    console.log();
    console.log('Index:');
    console.log(`  Documents:  ${status.index.totalDocuments}`);
    console.log(`  Sections:   ${status.index.totalSections}`);
    console.log(`  Dirty:      ${status.index.dirtyCount}`);
    console.log();

    if (status.worker) {
      console.log('Worker:');
      console.log(`  Running:    ${status.worker.running ? 'Yes' : 'No'}`);
      console.log(`  Processing: ${status.worker.processing}`);
      console.log(`  Queue:      ${status.worker.queue}`);
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

/**
 * アップタイムをフォーマット
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
