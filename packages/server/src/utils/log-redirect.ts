/**
 * ログリダイレクト設定
 */

import * as path from 'path';
import { mkdirSync } from 'fs';
import { RotatingWriteStream } from './rotating-log.js';

/**
 * ログ出力をRotatingWriteStreamにリダイレクト
 */
export function setupLogRedirect(logPath: string): void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = new RotatingWriteStream(logPath);

  const formatMessage = (args: unknown[]): string => {
    const timestamp = new Date().toISOString();
    const message = args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a, null, 2)
    ).join(' ');
    return `[${timestamp}] ${message}\n`;
  };

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => { logStream.write(formatMessage(args)); };
  console.error = (...args: unknown[]) => { logStream.write(formatMessage(['[ERROR]', ...args])); };
  console.warn = (...args: unknown[]) => { logStream.write(formatMessage(['[WARN]', ...args])); };

  // フォアグラウンドモードではコンソールにも出力
  if (process.stdout.isTTY) {
    console.log = (...args: unknown[]) => { logStream.write(formatMessage(args)); originalLog(...args); };
    console.error = (...args: unknown[]) => { logStream.write(formatMessage(['[ERROR]', ...args])); originalError(...args); };
    console.warn = (...args: unknown[]) => { logStream.write(formatMessage(['[WARN]', ...args])); originalWarn(...args); };
  }
}
