import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import type { SearchDocsConfig } from '@search-docs/types';
import { DEFAULT_CONFIG } from '@search-docs/types';
import { validateConfig } from './validator.js';

export class ConfigLoader {
  /**
   * 設定ファイルを読み込む
   * @param configPath 設定ファイルのパス（デフォルト: .search-docs/config.json）
   * @returns 設定オブジェクト
   */
  static async load(configPath: string = './.search-docs/config.json'): Promise<SearchDocsConfig> {
    try {
      // ファイルの存在確認
      await access(configPath, constants.F_OK | constants.R_OK);

      // ファイル読み込み
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      // バリデーション
      const config = validateConfig(parsed);

      // デフォルト値とマージ
      return this.mergeWithDefaults(config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // ファイルが存在しない場合はデフォルト設定を返す
        return DEFAULT_CONFIG;
      }
      throw error;
    }
  }

  /**
   * デフォルト設定を取得
   */
  static getDefaultConfig(): SearchDocsConfig {
    return DEFAULT_CONFIG;
  }

  /**
   * 設定とデフォルト値をマージ
   */
  private static mergeWithDefaults(config: Partial<SearchDocsConfig>): SearchDocsConfig {
    return {
      version: config.version ?? DEFAULT_CONFIG.version,
      project: {
        name: config.project?.name ?? DEFAULT_CONFIG.project.name,
        root: config.project?.root ?? DEFAULT_CONFIG.project.root,
      },
      files: {
        include: config.files?.include ?? DEFAULT_CONFIG.files.include,
        exclude: config.files?.exclude ?? DEFAULT_CONFIG.files.exclude,
        ignoreGitignore: config.files?.ignoreGitignore ?? DEFAULT_CONFIG.files.ignoreGitignore,
      },
      indexing: {
        maxTokensPerSection:
          config.indexing?.maxTokensPerSection ?? DEFAULT_CONFIG.indexing.maxTokensPerSection,
        minTokensForSplit:
          config.indexing?.minTokensForSplit ?? DEFAULT_CONFIG.indexing.minTokensForSplit,
        maxDepth: config.indexing?.maxDepth ?? DEFAULT_CONFIG.indexing.maxDepth,
        vectorDimension:
          config.indexing?.vectorDimension ?? DEFAULT_CONFIG.indexing.vectorDimension,
        embeddingModel:
          config.indexing?.embeddingModel ?? DEFAULT_CONFIG.indexing.embeddingModel,
      },
      search: {
        defaultLimit: config.search?.defaultLimit ?? DEFAULT_CONFIG.search.defaultLimit,
        maxLimit: config.search?.maxLimit ?? DEFAULT_CONFIG.search.maxLimit,
        includeCleanOnly:
          config.search?.includeCleanOnly ?? DEFAULT_CONFIG.search.includeCleanOnly,
      },
      server: {
        host: config.server?.host ?? DEFAULT_CONFIG.server.host,
        port: config.server?.port ?? DEFAULT_CONFIG.server.port,
        protocol: config.server?.protocol ?? DEFAULT_CONFIG.server.protocol,
      },
      storage: {
        documentsPath: config.storage?.documentsPath ?? DEFAULT_CONFIG.storage.documentsPath,
        indexPath: config.storage?.indexPath ?? DEFAULT_CONFIG.storage.indexPath,
        cachePath: config.storage?.cachePath ?? DEFAULT_CONFIG.storage.cachePath,
      },
      worker: {
        enabled: config.worker?.enabled ?? DEFAULT_CONFIG.worker.enabled,
        interval: config.worker?.interval ?? DEFAULT_CONFIG.worker.interval,
        maxConcurrent: config.worker?.maxConcurrent ?? DEFAULT_CONFIG.worker.maxConcurrent,
      },
    };
  }
}
