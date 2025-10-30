/**
 * index rebuild コマンド
 */

import { SearchDocsClient } from '@search-docs/client';

/**
 * index rebuild コマンドのオプション
 */
export interface IndexRebuildOptions {
  paths?: string[];
  force?: boolean;
  server?: string;
}

/**
 * index rebuild コマンドを実行
 */
export async function executeIndexRebuild(
  options: IndexRebuildOptions
): Promise<void> {
  try {
    const serverUrl = options.server || 'http://localhost:24280';
    const client = new SearchDocsClient({ baseUrl: serverUrl });

    console.log('Rebuilding index...');
    if (options.paths && options.paths.length > 0) {
      console.log(`Target paths: ${options.paths.join(', ')}`);
    } else {
      console.log('Target: All documents');
    }
    if (options.force) {
      console.log('Mode: Force rebuild (ignore hash check)');
    } else {
      console.log('Mode: Smart rebuild (skip unchanged files)');
    }

    const result = await client.rebuildIndex({
      paths: options.paths,
      force: options.force,
    });

    console.log('✓ Index rebuild completed');
    console.log(`  Documents processed: ${result.documentsProcessed}`);
    console.log(`  Sections created: ${result.sectionsCreated}`);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
