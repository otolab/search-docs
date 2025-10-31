import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import type { SearchDocsConfig } from '../config.js';
import { DEFAULT_CONFIG } from '../config.js';
import { validateConfig } from './validator.js';

/**
 * Config解決オプション
 */
export interface ResolveConfigOptions {
  /** 明示的に指定された設定ファイルパス */
  configPath?: string;
  /** 親ディレクトリを遡って探索するか（デフォルト: true） */
  traverseUp?: boolean;
  /** カレントワーキングディレクトリ（デフォルト: process.cwd()） */
  cwd?: string;
  /** 設定ファイルが必須かどうか（デフォルト: false）。trueの場合、見つからなければエラー */
  requireConfig?: boolean;
}

/**
 * 設定ファイル名の候補
 * 優先順位: .search-docs.json > search-docs.json
 */
const CONFIG_FILE_NAMES = ['.search-docs.json', 'search-docs.json'] as const;

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
      const parsed: unknown = JSON.parse(content);

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
   * 統一されたConfig解決
   * - 設定ファイルの自動探索
   * - プロジェクトルートの決定
   * - 設定の読み込み
   */
  static async resolve(
    options: ResolveConfigOptions = {}
  ): Promise<{
    config: SearchDocsConfig;
    configPath: string | null;
    projectRoot: string;
  }> {
    const { configPath: explicitPath, traverseUp = true, cwd = process.cwd(), requireConfig = false } = options;

    // 1. 設定ファイルパスを解決
    const configPath = await this.resolveConfigPath(explicitPath, cwd, traverseUp);

    // 設定ファイルが必須なのに見つからない場合はエラー
    if (!configPath && requireConfig) {
      throw new Error(
        'Configuration file not found. Please create a configuration file.\n' +
        'Run: search-docs config init'
      );
    }

    // 2. プロジェクトルートを決定
    let projectRoot: string;

    if (configPath) {
      try {
        // 設定ファイルを読み込んで project.root を確認
        const configContent = await readFile(configPath, 'utf-8');
        const parsedConfig = JSON.parse(configContent) as {
          project?: { root?: string };
        };

        if (parsedConfig.project?.root) {
          // 設定ファイルで明示的に指定されている場合
          const configDir = path.dirname(configPath);
          projectRoot = await this.normalizeProjectRoot(
            path.resolve(configDir, parsedConfig.project.root)
          );
        } else {
          // 設定ファイルの親ディレクトリをプロジェクトルートとする
          projectRoot = await this.getProjectRootFromConfig(configPath);
        }
      } catch (_error) {
        // 設定ファイルが読み込めない場合は親ディレクトリを使用
        projectRoot = await this.getProjectRootFromConfig(configPath);
      }
    } else {
      // 設定ファイルが見つからない場合はカレントディレクトリを使用
      projectRoot = await this.normalizeProjectRoot(cwd);
    }

    // 3. ConfigLoaderで読み込み
    const config = configPath
      ? await this.load(configPath)
      : this.getDefaultConfig();

    return { config, configPath, projectRoot };
  }

  /**
   * デフォルト設定を取得
   */
  static getDefaultConfig(): SearchDocsConfig {
    return DEFAULT_CONFIG;
  }

  /**
   * 設定ファイルを探索
   * @param startDir 探索開始ディレクトリ
   * @param traverseUp 親ディレクトリを遡るかどうか
   */
  private static async findConfigFile(
    startDir: string = process.cwd(),
    traverseUp: boolean = true
  ): Promise<string | null> {
    let currentDir = path.resolve(startDir);
    const root = path.parse(currentDir).root;

    while (true) {
      // 候補ファイルを順に試す
      for (const fileName of CONFIG_FILE_NAMES) {
        const configPath = path.join(currentDir, fileName);

        try {
          await access(configPath);
          return configPath;
        } catch {
          // ファイルが存在しない、次を試す
          continue;
        }
      }

      // 親を遡らない場合はここで終了
      if (!traverseUp) {
        return null;
      }

      // ルートディレクトリに到達したら終了
      if (currentDir === root) {
        return null;
      }

      // 親ディレクトリへ
      currentDir = path.dirname(currentDir);
    }
  }

  /**
   * 設定ファイルパスを解決
   * @param explicitPath 明示的に指定されたパス
   * @param cwd カレントワーキングディレクトリ
   * @param traverseUp 親ディレクトリを遡るかどうか
   */
  private static async resolveConfigPath(
    explicitPath?: string,
    cwd: string = process.cwd(),
    traverseUp: boolean = true
  ): Promise<string | null> {
    // 1. 明示的に指定されている
    if (explicitPath) {
      return path.resolve(cwd, explicitPath);
    }

    // 2. 環境変数
    const envPath = process.env.SEARCH_DOCS_CONFIG;
    if (envPath) {
      return path.resolve(cwd, envPath);
    }

    // 3. 自動探索
    return await this.findConfigFile(cwd, traverseUp);
  }

  /**
   * プロジェクトルートを正規化
   * - 絶対パスに変換
   * - シンボリックリンクを解決
   * - 末尾のスラッシュを削除
   */
  private static async normalizeProjectRoot(root: string): Promise<string> {
    // 絶対パスに変換
    const absolutePath = path.resolve(root);

    try {
      // シンボリックリンクを解決
      const fs = await import('fs/promises');
      const realPath = await fs.realpath(absolutePath);

      // 末尾のスラッシュを削除
      return realPath.replace(/\/$/, '');
    } catch (_error) {
      // ディレクトリが存在しない場合は絶対パスをそのまま返す
      return absolutePath.replace(/\/$/, '');
    }
  }

  /**
   * 設定ファイルパスからプロジェクトルートを取得
   */
  private static async getProjectRootFromConfig(
    configPath: string
  ): Promise<string> {
    // 設定ファイルの親ディレクトリ
    const configDir = path.dirname(path.resolve(configPath));

    return await this.normalizeProjectRoot(configDir);
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
      watcher: {
        enabled: config.watcher?.enabled ?? DEFAULT_CONFIG.watcher.enabled,
        debounceMs: config.watcher?.debounceMs ?? DEFAULT_CONFIG.watcher.debounceMs,
        awaitWriteFinishMs:
          config.watcher?.awaitWriteFinishMs ?? DEFAULT_CONFIG.watcher.awaitWriteFinishMs,
      },
    };
  }
}
