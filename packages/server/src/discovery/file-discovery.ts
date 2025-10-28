import fg from 'fast-glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FilesConfig } from '@search-docs/types';

// ignoreパッケージの型定義（手動）
interface Ignore {
  add(pattern: string | string[]): this;
  ignores(pathname: string): boolean;
}

// ignoreパッケージのファクトリ関数をdynamic importで使用
let ignoreFactory: (() => Ignore) | null = null;

export interface FileDiscoveryOptions {
  /** プロジェクトルート */
  rootDir: string;
  /** ファイル検索設定 */
  config: FilesConfig;
}

/**
 * ファイル検索クラス
 * Globパターンと.gitignoreを使用してMarkdownファイルを検索
 */
export class FileDiscovery {
  private rootDir: string;
  private config: FilesConfig;
  private ignoreFilter: Ignore | null = null;

  constructor(options: FileDiscoveryOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.config = options.config;
  }

  /**
   * ファイルを検索
   * @returns 見つかったファイルのパス一覧（プロジェクトルートからの相対パス）
   */
  async findFiles(): Promise<string[]> {
    // .gitignoreを読み込む
    if (this.config.ignoreGitignore) {
      await this.loadGitignore();
    }

    // fast-globで検索
    const files = await fg(this.config.include, {
      cwd: this.rootDir,
      ignore: this.config.exclude,
      absolute: false, // 相対パスを返す
      onlyFiles: true,
      dot: false, // ドットファイルを除外
    });

    // .gitignoreフィルタを適用
    if (this.ignoreFilter) {
      return files.filter((file) => !this.ignoreFilter!.ignores(file));
    }

    return files;
  }

  /**
   * パスがパターンにマッチするか判定
   * @param filePath ファイルパス（相対パス）
   * @returns マッチする場合true
   */
  matchesPattern(filePath: string): boolean {
    // includeパターンにマッチするか
    const matchesInclude = this.config.include.some((pattern) => {
      // minimatchはfast-globと異なり、**/patternがルートレベルにマッチしない
      // fast-globの挙動に合わせるため、**/で始まるパターンは
      // ルートレベルとネストレベルの両方をチェック
      if (pattern.startsWith('**/')) {
        const rootPattern = pattern.slice(3); // '**/'を除去
        return minimatch(filePath, pattern) || minimatch(filePath, rootPattern);
      }
      return minimatch(filePath, pattern);
    });

    if (!matchesInclude) {
      return false;
    }

    // excludeパターンにマッチしないか
    const matchesExclude = this.config.exclude.some((pattern) => {
      // exclude側も同様の処理
      if (pattern.startsWith('**/')) {
        const rootPattern = pattern.slice(3);
        return minimatch(filePath, pattern) || minimatch(filePath, rootPattern);
      }
      return minimatch(filePath, pattern);
    });

    return !matchesExclude;
  }

  /**
   * パスを除外すべきか判定
   * @param filePath ファイルパス（相対パス）
   * @returns 除外する場合true
   */
  shouldIgnore(filePath: string): boolean {
    // .gitignoreフィルタ
    if (this.config.ignoreGitignore && this.ignoreFilter) {
      if (this.ignoreFilter.ignores(filePath)) {
        return true;
      }
    }

    // パターンマッチング
    return !this.matchesPattern(filePath);
  }

  /**
   * .gitignoreを読み込む
   */
  private async loadGitignore(): Promise<void> {
    try {
      // ignoreパッケージを動的にロード
      if (!ignoreFactory) {
        const ignoreModule = await import('ignore');
        ignoreFactory = ignoreModule.default as unknown as () => Ignore;
      }

      const gitignorePath = path.join(this.rootDir, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf-8');
      this.ignoreFilter = ignoreFactory().add(content);
    } catch (error) {
      // .gitignoreが存在しない場合は無視
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
