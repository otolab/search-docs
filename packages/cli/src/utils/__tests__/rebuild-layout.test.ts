import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { validateRebuildLayout } from '../rebuild-layout.js';

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rebuild-layout-'));
  temporary.push(root);
  await mkdir(path.join(root, '.search-docs'));
  return { projectRoot: root, indexPath: '.search-docs/index', documentsPath: '.search-docs/documents' };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('validateRebuildLayout', () => {
  it('標準配置を実体パスとして返し、ファイルを変更しない', async () => {
    const config = await fixture();
    await mkdir(path.join(config.projectRoot, config.indexPath));
    const marker = path.join(config.projectRoot, config.indexPath, 'keep');
    await writeFile(marker, 'keep');
    const result = await validateRebuildLayout(config);
    expect(path.basename(result.indexPath)).toBe('index');
    expect(path.dirname(result.indexPath)).toBe(path.dirname(result.documentsPath));
    expect(await readFile(marker, 'utf8')).toBe('keep');
  });

  it('非標準配置を拒否し、安全な手動復旧案内を返す', async () => {
    const config = await fixture();
    await expect(validateRebuildLayout({ ...config, indexPath: '.search-docs/other' })).rejects.toThrow(/すべてのプロセスを停止/);
    await expect(validateRebuildLayout({ ...config, documentsPath: 'other/documents' })).rejects.toThrow(/確認できない場合は削除せず/);
  });

  it('index がプロジェクトルートを含む配置を拒否する', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'rebuild-layout-'));
    temporary.push(parent);
    const root = path.join(parent, 'index');
    await mkdir(root);
    await expect(validateRebuildLayout({ projectRoot: root, indexPath: root, documentsPath: path.join(parent, 'documents') })).rejects.toThrow(/削除対象がプロジェクト/);
  });

  it.each(['index', 'documents', '.search-docs-maintenance'])('%s のシンボリックリンクを拒否する', async name => {
    const config = await fixture();
    await symlink(config.projectRoot, path.join(config.projectRoot, '.search-docs', name));
    await expect(validateRebuildLayout(config)).rejects.toThrow(/シンボリックリンク/);
  });

  it('親が存在しない場合は削除せず案内する', async () => {
    const config = await fixture();
    await expect(validateRebuildLayout({ ...config, indexPath: 'missing/index', documentsPath: 'missing/documents' })).rejects.toThrow(/保存領域を確認できません/);
  });
});
