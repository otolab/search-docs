/**
 * ServerManager.getAllRelatedProjects のテスト
 */

import { describe, it, expect } from 'vitest';
import { ServerManager } from '../server-manager.js';

describe('ServerManager.getAllRelatedProjects', () => {
  it('config由来のdirを絶対パスに解決する', () => {
    const manager = new ServerManager();

    const result = manager.getAllRelatedProjects(
      {
        'project-a': { dir: '../other-project', description: 'テスト' },
      },
      '/home/user/main-project/.search-docs.json'
    );

    expect(result['project-a']).toBeDefined();
    expect(result['project-a'].dir).toBe('/home/user/other-project');
    expect(result['project-a'].description).toBe('テスト');
  });

  it('一時追加プロジェクトはそのまま返す', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('temp-project', {
      dir: '/absolute/path/to/project',
      description: '一時追加',
    });

    const result = manager.getAllRelatedProjects();

    expect(result['temp-project']).toBeDefined();
    expect(result['temp-project'].dir).toBe('/absolute/path/to/project');
  });

  it('config由来と一時追加をマージして返す', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('temp-project', {
      dir: '/tmp/temp',
    });

    const result = manager.getAllRelatedProjects(
      {
        'config-project': { dir: '../config-proj' },
      },
      '/home/user/main/.search-docs.json'
    );

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['config-project']).toBeDefined();
    expect(result['temp-project']).toBeDefined();
  });

  it('同名の場合は一時追加が優先される', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('project-a', {
      dir: '/tmp/temporary',
      description: '一時追加版',
    });

    const result = manager.getAllRelatedProjects(
      {
        'project-a': { dir: '../config-version', description: 'config版' },
      },
      '/home/user/main/.search-docs.json'
    );

    expect(result['project-a'].dir).toBe('/tmp/temporary');
    expect(result['project-a'].description).toBe('一時追加版');
  });

  it('configPathなしの場合、config由来のプロジェクトは含まれない', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('temp', { dir: '/tmp/temp' });

    const result = manager.getAllRelatedProjects(
      { 'config-proj': { dir: '../somewhere' } },
      undefined
    );

    expect(result['config-proj']).toBeUndefined();
    expect(result['temp']).toBeDefined();
  });

  it('両方空の場合は空オブジェクトを返す', () => {
    const manager = new ServerManager();
    const result = manager.getAllRelatedProjects();
    expect(Object.keys(result)).toHaveLength(0);
  });
});
