import * as fs from 'fs';
import * as path from 'path';
import { ConfigLoader } from '@search-docs/config';

export interface IndexPurgeOptions {
  config?: string;
}

export async function executeIndexPurge(
  options: IndexPurgeOptions
): Promise<void> {
  try {
    const { config, projectRoot } = await ConfigLoader.resolve({
      cwd: process.cwd(),
      configPath: options.config,
    });

    if (!config) {
      console.error('設定ファイルが見つかりません。先に search-docs config init を実行してください。');
      process.exit(1);
    }

    const indexPath = path.resolve(projectRoot, config.storage.indexPath);

    if (!fs.existsSync(indexPath)) {
      console.log(`インデックスディレクトリが存在しません: ${indexPath}`);
      return;
    }

    console.log(`インデックスを削除します: ${indexPath}`);
    fs.rmSync(indexPath, { recursive: true, force: true });
    console.log('インデックスを削除しました。');
    console.log('再構築するには: search-docs index rebuild');
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}
