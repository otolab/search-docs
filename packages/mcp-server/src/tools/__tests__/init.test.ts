/**
 * initツールのテスト
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { registerInitTool } from '../init.js';
import type { ToolRegistrationContext } from '../types.js';

describe('init tool', () => {
  let testDir: string;
  let registeredTool: any;
  let mockServer: any;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join('/tmp', 'mcp-init-test-'));
    mockServer = {
      registerTool: vi.fn((name, schema, handler) => {
        registeredTool = { name, schema, handler };
        return {
          enable: vi.fn(),
          disable: vi.fn(),
        };
      }),
    };
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it.each([
    '.search-docs/config.json',
    '.search-docs.json',
    'search-docs.json',
  ])('既存の設定（%s）がある場合はforce:falseで変更しない', async (relativePath) => {
    const configPath = path.join(testDir, relativePath);
    const originalContent = '{"sentinel":"keep"}\n';
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, originalContent, 'utf-8');

    const refreshSystemState = vi.fn().mockResolvedValue(undefined);
    const context = {
      server: mockServer,
      systemState: {
        state: 'RUNNING' as const,
        projectRoot: testDir,
      },
      refreshSystemState,
      serverManager: {} as ToolRegistrationContext['serverManager'],
    } satisfies ToolRegistrationContext;

    registerInitTool(context);
    const result = await registeredTool.handler({ force: false, port: 54332 });
    const resultText = result.content[0].text;

    expect(resultText).toContain('⚠️');
    expect(resultText).toContain('既存の設定は変更されていません');
    expect(resultText).not.toContain('✅ 設定ファイルの初期化が完了しました');
    expect(await fs.readFile(configPath, 'utf-8')).toBe(originalContent);
    expect(refreshSystemState).not.toHaveBeenCalled();
  });
});
