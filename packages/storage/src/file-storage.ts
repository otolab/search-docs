/**
 * ファイルベースのDocumentStorage実装
 */

import { promises as fs } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { createHash } from 'node:crypto';
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

    // JSON形式で保存
    await fs.writeFile(
      filePath,
      JSON.stringify(docWithHash, null, 2),
      'utf-8'
    );
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
  async list(): Promise<string[]> {
    const paths: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            // ベースパスからの相対パスを計算
            const relativePath = fullPath
              .slice(this.basePath.length + 1)
              .replace(/\.json$/, '')
              .replace(/\\/g, '/');
            paths.push(relativePath);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
