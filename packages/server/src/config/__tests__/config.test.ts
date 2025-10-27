import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigLoader } from '../loader.js';
import { validateConfig } from '../validator.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

const TEST_DIR = path.join(tmpdir(), 'search-docs-config-test');

describe('ConfigLoader', () => {
  beforeAll(async () => {
    // テスト用ディレクトリ作成
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    // テスト用ディレクトリ削除
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('getDefaultConfig', () => {
    it('デフォルト設定を取得できる', () => {
      const config = ConfigLoader.getDefaultConfig();
      expect(config).toBeDefined();
      expect(config.version).toBe('1.0');
      expect(config.files.include).toEqual(['**/*.md']);
      expect(config.indexing.maxTokensPerSection).toBe(2000);
    });
  });

  describe('load', () => {
    it('存在しないファイルはデフォルト設定を返す', async () => {
      const config = await ConfigLoader.load(path.join(TEST_DIR, 'nonexistent.json'));
      expect(config).toEqual(ConfigLoader.getDefaultConfig());
    });

    it('有効な設定ファイルを読み込める', async () => {
      const configPath = path.join(TEST_DIR, 'valid.json');
      const testConfig = {
        version: '1.0',
        files: {
          include: ['**/*.mdx'],
          exclude: ['**/test/**'],
          ignoreGitignore: false,
        },
      };

      await fs.writeFile(configPath, JSON.stringify(testConfig, null, 2));

      const config = await ConfigLoader.load(configPath);
      expect(config.files.include).toEqual(['**/*.mdx']);
      expect(config.files.exclude).toEqual(['**/test/**']);
      expect(config.files.ignoreGitignore).toBe(false);
      // デフォルト値がマージされる
      expect(config.indexing.maxTokensPerSection).toBe(2000);
    });

    it('部分的な設定をデフォルト値とマージする', async () => {
      const configPath = path.join(TEST_DIR, 'partial.json');
      const testConfig = {
        indexing: {
          maxTokensPerSection: 1000,
        },
      };

      await fs.writeFile(configPath, JSON.stringify(testConfig, null, 2));

      const config = await ConfigLoader.load(configPath);
      expect(config.indexing.maxTokensPerSection).toBe(1000);
      // 他はデフォルト値
      expect(config.files.include).toEqual(['**/*.md']);
      expect(config.indexing.minTokensForSplit).toBe(100);
    });

    it('不正なJSON形式でエラー', async () => {
      const configPath = path.join(TEST_DIR, 'invalid-json.json');
      await fs.writeFile(configPath, '{ invalid json }');

      await expect(ConfigLoader.load(configPath)).rejects.toThrow();
    });
  });
});

describe('validateConfig', () => {
  it('有効な設定を検証できる', () => {
    const config = {
      version: '1.0',
      project: {
        name: 'test',
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
        port: 24280,
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
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it('オブジェクト以外でエラー', () => {
    expect(() => validateConfig(null)).toThrow('Config must be an object');
    expect(() => validateConfig('string')).toThrow('Config must be an object');
    expect(() => validateConfig(123)).toThrow('Config must be an object');
  });

  describe('files設定', () => {
    it('includeが配列でない場合エラー', () => {
      const config = {
        files: {
          include: 'not-array',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.files.include must be an array');
    });

    it('includeが文字列配列でない場合エラー', () => {
      const config = {
        files: {
          include: [1, 2, 3],
        },
      };
      expect(() => validateConfig(config)).toThrow(
        'config.files.include must be an array of strings'
      );
    });

    it('excludeが配列でない場合エラー', () => {
      const config = {
        files: {
          exclude: 'not-array',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.files.exclude must be an array');
    });

    it('ignoreGitignoreがbooleanでない場合エラー', () => {
      const config = {
        files: {
          ignoreGitignore: 'not-boolean',
        },
      };
      expect(() => validateConfig(config)).toThrow(
        'config.files.ignoreGitignore must be a boolean'
      );
    });
  });

  describe('indexing設定', () => {
    it('maxTokensPerSectionが数値でない場合エラー', () => {
      const config = {
        indexing: {
          maxTokensPerSection: 'not-number',
        },
      };
      expect(() => validateConfig(config)).toThrow(
        'config.indexing.maxTokensPerSection must be a number'
      );
    });

    it('maxTokensPerSectionが0以下の場合エラー', () => {
      const config = {
        indexing: {
          maxTokensPerSection: 0,
        },
      };
      expect(() => validateConfig(config)).toThrow(
        'config.indexing.maxTokensPerSection must be positive'
      );
    });

    it('maxDepthが範囲外の場合エラー', () => {
      const config1 = {
        indexing: {
          maxDepth: -1,
        },
      };
      expect(() => validateConfig(config1)).toThrow(
        'config.indexing.maxDepth must be between 0 and 3'
      );

      const config2 = {
        indexing: {
          maxDepth: 4,
        },
      };
      expect(() => validateConfig(config2)).toThrow(
        'config.indexing.maxDepth must be between 0 and 3'
      );
    });

    it('vectorDimensionが256または768以外の場合エラー', () => {
      const config = {
        indexing: {
          vectorDimension: 512,
        },
      };
      expect(() => validateConfig(config)).toThrow(
        'config.indexing.vectorDimension must be 256 or 768'
      );
    });
  });

  describe('worker設定', () => {
    it('intervalが数値でない場合エラー', () => {
      const config = {
        worker: {
          interval: 'not-number',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.worker.interval must be a number');
    });

    it('intervalが0以下の場合エラー', () => {
      const config = {
        worker: {
          interval: 0,
        },
      };
      expect(() => validateConfig(config)).toThrow('config.worker.interval must be positive');
    });

    it('maxConcurrentが数値でない場合エラー', () => {
      const config = {
        worker: {
          maxConcurrent: 'not-number',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.worker.maxConcurrent must be a number');
    });
  });

  describe('watcher設定のバリデーション', () => {
    it('正しいwatcher設定', () => {
      const config = {
        watcher: {
          enabled: true,
          debounceMs: 300,
          awaitWriteFinishMs: 200,
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('enabledがboolean型でない場合エラー', () => {
      const config = {
        watcher: {
          enabled: 'yes',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.watcher.enabled must be a boolean');
    });

    it('debounceMsが数値でない場合エラー', () => {
      const config = {
        watcher: {
          debounceMs: '300',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.watcher.debounceMs must be a number');
    });

    it('awaitWriteFinishMsが数値でない場合エラー', () => {
      const config = {
        watcher: {
          awaitWriteFinishMs: '200',
        },
      };
      expect(() => validateConfig(config)).toThrow('config.watcher.awaitWriteFinishMs must be a number');
    });
  });
});
