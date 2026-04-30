/**
 * ServerManager.getAllRelatedProjects のテスト
 */

import { describe, it, expect } from 'vitest';
import { ServerManager } from '../server-manager.js';

describe('ServerManager.getAllRelatedProjects', () => {
  it('config由来のプロジェクトをそのまま返す', () => {
    const manager = new ServerManager();

    const result = manager.getAllRelatedProjects({
      'project-a': { url: 'http://localhost:3000', description: 'テスト' },
    });

    expect(result['project-a']).toBeDefined();
    expect(result['project-a'].url).toBe('http://localhost:3000');
    expect(result['project-a'].description).toBe('テスト');
  });

  it('一時追加プロジェクトはそのまま返す', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('temp-project', {
      url: 'http://localhost:4000',
      description: '一時追加',
    });

    const result = manager.getAllRelatedProjects();

    expect(result['temp-project']).toBeDefined();
    expect(result['temp-project'].url).toBe('http://localhost:4000');
  });

  it('config由来と一時追加をマージして返す', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('temp-project', {
      url: 'http://localhost:5000',
    });

    const result = manager.getAllRelatedProjects({
      'config-project': { url: 'http://localhost:6000' },
    });

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['config-project']).toBeDefined();
    expect(result['temp-project']).toBeDefined();
  });

  it('同名の場合は一時追加が優先される', () => {
    const manager = new ServerManager();
    manager.addTemporaryRelatedProject('project-a', {
      url: 'http://localhost:7000',
      description: '一時追加版',
    });

    const result = manager.getAllRelatedProjects({
      'project-a': { url: 'http://localhost:8000', description: 'config版' },
    });

    expect(result['project-a'].url).toBe('http://localhost:7000');
    expect(result['project-a'].description).toBe('一時追加版');
  });

  it('両方空の場合は空オブジェクトを返す', () => {
    const manager = new ServerManager();
    const result = manager.getAllRelatedProjects();
    expect(Object.keys(result)).toHaveLength(0);
  });
});
