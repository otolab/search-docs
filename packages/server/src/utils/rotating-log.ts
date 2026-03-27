/**
 * サイズベースのログローテーション
 */

import { createWriteStream, statSync, renameSync, unlinkSync, existsSync, type WriteStream } from 'fs';
import { Writable } from 'stream';

export interface RotatingLogOptions {
  /** ローテーション閾値（バイト） */
  maxSize: number;
  /** 保持する世代数 */
  maxFiles: number;
}

const DEFAULT_OPTIONS: RotatingLogOptions = {
  maxSize: 1 * 1024 * 1024, // 1MB
  maxFiles: 3,
};

export class RotatingWriteStream extends Writable {
  private filePath: string;
  private options: RotatingLogOptions;
  private stream: WriteStream;
  private currentSize: number;

  constructor(filePath: string, options?: Partial<RotatingLogOptions>) {
    super();
    this.filePath = filePath;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.currentSize = this.getFileSize();
    this.stream = createWriteStream(filePath, { flags: 'a' });
  }

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    this.currentSize += data.length;

    this.stream.write(data, encoding, (err) => {
      if (err) {
        callback(err);
        return;
      }

      if (this.currentSize >= this.options.maxSize) {
        this.rotate();
      }

      callback();
    });
  }

  _final(callback: (error?: Error | null) => void): void {
    this.stream.end(callback);
  }

  private getFileSize(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    // 現在のストリームを閉じる
    this.stream.end();

    // 最古の世代を削除
    const oldest = `${this.filePath}.${this.options.maxFiles}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* ignore */ }
    }

    // 世代をシフト: .{n} → .{n+1}
    for (let i = this.options.maxFiles - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }

    // current → .1
    if (existsSync(this.filePath)) {
      try { renameSync(this.filePath, `${this.filePath}.1`); } catch { /* ignore */ }
    }

    // 新しいストリームを開く
    this.stream = createWriteStream(this.filePath, { flags: 'w' });
    this.currentSize = 0;
  }
}
