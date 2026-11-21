/**
 * ファイルベースのDocumentStorage実装
 */

import { promises as fs } from 'node:fs';
import { join, dirname, normalize, relative, isAbsolute, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Document, DocumentStorage } from '@search-docs/types';

export interface FileStorageOptions {
  /** ストレージのベースディレクトリ */
  basePath: string;
}

/**
 * ファイルベースのDocumentStorage
 * JSON形式で文書を保存
 */
export class FileStorage implements DocumentStorage {
  private basePath: string;

  constructor(options: FileStorageOptions) {
    this.basePath = normalize(options.basePath);
  }

  getBasePath(): string { return this.basePath; }

  /**
   * 文書を保存
   */
  async save(path: string, document: Document): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const filePath = this.getFilePath(normalizedPath);

    // ディレクトリを作成
    await fs.mkdir(dirname(filePath), { recursive: true });

    // 文書のハッシュを計算
    const hash = this.calculateHash(document.content);
    const docWithHash: Document = {
      ...document,
      metadata: {
        ...document.metadata,
        fileHash: hash,
      },
    };

    // Atomic write: tmp → rename でデータ破損を防止
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(docWithHash, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  /**
   * 再構築専用。呼び出し元は保存領域の排他を持ち、非協調利用者と
   * パス・マウントの変更を停止する。通常の save の互換性は変更しない。
   */
  async saveForRebuild(documentPath: string, document: Document): Promise<void> {
    if (isAbsolute(documentPath) || documentPath.split(/[\\/]/).some(part => part === '..' || part === '')) {
      throw new Error(`不正な文書パスです: ${documentPath}`);
    }
    const root = resolve(this.basePath);
    const target = resolve(root, `${documentPath}.json`);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文書保存先が管理領域外です');
    const checkDirectory = async (dir: string) => {
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`文書保存先が通常のディレクトリではありません: ${dir}`);
    };
    try { await fs.mkdir(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await checkDirectory(root);
    let current = root;
    const parent = relative(root, dirname(target));
    for (const segment of parent ? parent.split(sep) : []) {
      current = join(current, segment);
      try { await fs.mkdir(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await checkDirectory(current);
    }
    const lockPath = `${target}.rebuild-lock`;
    const lock = await fs.open(lockPath, 'wx', 0o600);
    const tmpPath = `${target}.${randomUUID()}.tmp`;
    let createdTmp = false;
    try {
      for (const candidate of [target, `${target}.tmp`]) {
        try {
          const info = await fs.lstat(candidate);
          if (candidate !== target || !info.isFile() || info.isSymbolicLink()) {
            throw new Error(`文書保存先を確認できません: ${candidate}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const docWithHash = {
        ...document,
        metadata: { ...document.metadata, fileHash: this.calculateHash(document.content) },
      };
      const tmp = await fs.open(tmpPath, 'wx', 0o600);
      createdTmp = true;
      try { await tmp.writeFile(JSON.stringify(docWithHash, null, 2), 'utf8'); } finally { await tmp.close(); }
      await fs.rename(tmpPath, target);
      createdTmp = false;
    } finally {
      if (createdTmp) await fs.unlink(tmpPath);
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  /**
   * 文書を取得
   */
  async get(path: string): Promise<Document | null> {
    const normalizedPath = this.normalizePath(path);
    const filePath = this.getFilePath(normalizedPath);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const document = JSON.parse(content) as Document;

      // Date型に変換
      document.metadata.createdAt = new Date(document.metadata.createdAt);
      document.metadata.updatedAt = new Date(document.metadata.updatedAt);

      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 文書を削除
   */
  async delete(path: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const filePath = this.getFilePath(normalizedPath);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // 既に存在しない場合はエラーにしない
        return;
      }
      throw error;
    }
  }

  /**
   * すべての文書パスを取得
   */
  async list(options: { strict?: boolean } = {}): Promise<string[]> {
    const paths: string[] = [];
    const root = options.strict ? await fs.realpath(this.basePath) : undefined;

    const walk = async (dir: string, ancestors = new Set<string>()): Promise<void> => {
      try {
        const realDir = options.strict ? await fs.realpath(dir) : dir;
        if (options.strict && root) {
          const rel = relative(root, realDir);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || ancestors.has(realDir)) {
            throw new Error('Storage symlink escapes its root or forms a cycle');
          }
        }
        const nextAncestors = new Set(ancestors).add(realDir);
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          const symlinkStat = options.strict && entry.isSymbolicLink() ? await fs.stat(fullPath) : undefined;
          if (entry.isDirectory() || symlinkStat?.isDirectory()) {
            await walk(fullPath, nextAncestors);
          } else if ((entry.isFile() || symlinkStat?.isFile()) && entry.name.endsWith('.json')) {
            // ベースパスからの相対パスを計算
            const relativePath = fullPath
              .slice(this.basePath.length + 1)
              .replace(/\.json$/, '')
              .replace(/\\/g, '/');
            paths.push(relativePath);
          }
        }
      } catch (error) {
        if (!options.strict && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          // ディレクトリが存在しない場合は空配列を返す
          return;
        }
        throw error;
      }
    };

    await walk(this.basePath);
    return paths;
  }

  /**
   * 文書の存在確認
   */
  async exists(path: string): Promise<boolean> {
    const normalizedPath = this.normalizePath(path);
    const filePath = this.getFilePath(normalizedPath);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * パスを正規化
   */
  private normalizePath(path: string): string {
    return normalize(path).replace(/\\/g, '/');
  }

  /**
   * ファイルパスを取得
   */
  private getFilePath(normalizedPath: string): string {
    return join(this.basePath, `${normalizedPath}.json`);
  }

  /**
   * 内容のハッシュを計算
   */
  private calculateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
