/**
 * コマンドライン引数解析のテスト
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as path from 'path';

/**
 * parseArgs() の簡易実装（テスト用）
 */
function parseArgs(argv: string[]): { projectDir?: string } {
  const program = new Command();

  program
    .name('search-docs-mcp')
    .description('MCP Server for search-docs - Claude Code integration')
    .version('0.1.0')
    .option('--project-dir <path>', 'Project directory path (optional, will auto-detect from config file if not specified)')
    .exitOverride() // テスト時はexitしない
    .parse(argv, { from: 'user' });

  const options = program.opts<{ projectDir?: string }>();

  return {
    projectDir: options.projectDir ? path.resolve(options.projectDir) : undefined,
  };
}

describe('MCP Server - コマンドライン引数解析', () => {
  let originalArgv: string[];

  beforeEach(() => {
    // 元のargvを保存
    originalArgv = process.argv;
  });

  afterEach(() => {
    // argvを復元
    process.argv = originalArgv;
  });

  it('--project-dir が指定された場合、そのパスを使用', () => {
    const args = parseArgs(['node', 'server.js', '--project-dir', '/path/to/project']);

    expect(args.projectDir).toBe(path.resolve('/path/to/project'));
  });

  it('--project-dir が指定されていない場合、undefined', () => {
    const args = parseArgs(['node', 'server.js']);

    expect(args.projectDir).toBeUndefined();
  });

  it('--project-dir を相対パスで指定した場合、絶対パスに解決', () => {
    const args = parseArgs(['node', 'server.js', '--project-dir', './relative/path']);

    expect(args.projectDir).toBe(path.resolve('./relative/path'));
  });
});
