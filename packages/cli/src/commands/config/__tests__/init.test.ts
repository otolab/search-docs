/**
 * config init コマンドのテスト
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { initConfig } from '../init.js';

describe('config init', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(async () => {
    // 各テストで独立したディレクトリを作成
    testDir = path.join('/tmp', `.test-config-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    configPath = path.join(testDir, '.search-docs.json');
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // テストディレクトリを削除
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('設定ファイルを生成できる', async () => {
    await initConfig({ cwd: testDir });

    // ファイルが存在することを確認
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // ファイルの内容を確認
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.version).toBe('1.0');
    expect(config.project.name).toMatch(/\.test-config-init-/);
    expect(config.server.host).toBe('localhost');
    expect(config.server.port).toBeGreaterThanOrEqual(49152);
    expect(config.server.port).toBeLessThanOrEqual(65535);
  });

  it('ポート番号を指定できる', async () => {
    await initConfig({ cwd: testDir, port: 12345 });

    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.server.port).toBe(12345);
  });

  it('プロジェクトルートを指定できる', async () => {
    await initConfig({ cwd: testDir, projectRoot: '/custom/root' });

    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.project.root).toBe('.');
  });

  it('既存ファイルがある場合はエラーを投げる', async () => {
    // 最初に設定ファイルを作成
    await initConfig({ cwd: testDir });

    // 2回目はエラーになる
    await expect(initConfig({ cwd: testDir })).rejects.toThrow('Configuration file already exists');
  });

  it('--forceオプションで既存ファイルを上書きできる', async () => {
    // 最初に設定ファイルを作成（ポート12345）
    await initConfig({ cwd: testDir, port: 12345 });

    let content = await fs.readFile(configPath, 'utf-8');
    let config = JSON.parse(content);
    expect(config.server.port).toBe(12345);

    // --forceで上書き（ポート54321）
    await initConfig({ cwd: testDir, port: 54321, force: true });

    content = await fs.readFile(configPath, 'utf-8');
    config = JSON.parse(content);
    expect(config.server.port).toBe(54321);
  });

  it('生成された設定ファイルが妥当なJSON形式である', async () => {
    await initConfig({ cwd: testDir });

    const content = await fs.readFile(configPath, 'utf-8');

    // JSON.parseでエラーが出ないことを確認
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('デフォルト設定が全て含まれている', async () => {
    await initConfig({ cwd: testDir });

    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    // 必須フィールドの存在を確認
    expect(config).toHaveProperty('version');
    expect(config).toHaveProperty('project');
    expect(config).toHaveProperty('files');
    expect(config).toHaveProperty('indexing');
    expect(config).toHaveProperty('search');
    expect(config).toHaveProperty('server');
    expect(config).toHaveProperty('storage');
    expect(config).toHaveProperty('worker');
    expect(config).toHaveProperty('watcher');

    // 各セクションの必須フィールド
    expect(config.project).toHaveProperty('name');
    expect(config.project).toHaveProperty('root');
    expect(config.files).toHaveProperty('include');
    expect(config.files).toHaveProperty('exclude');
    expect(config.server).toHaveProperty('host');
    expect(config.server).toHaveProperty('port');
  });
});
