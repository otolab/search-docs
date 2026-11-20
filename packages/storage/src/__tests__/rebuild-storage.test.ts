import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileStorage } from '../file-storage.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rebuild-storage-'));
  roots.push(root);
  const base = path.join(root, 'documents');
  await mkdir(base);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  const doc = { path: 'nested/a.md', content: 'content', metadata: { createdAt: new Date(), updatedAt: new Date(), fileHash: '' } };
  return { root, base, outside, doc, storage: new FileStorage({ basePath: base }) };
}
describe('再構築専用の文書保存', () => {
  it('通常形式で保存・更新し、既存の読み出しで取得できる', async () => {
    const { storage, doc } = await fixture();
    await storage.saveForRebuild(doc.path, doc);
    await storage.saveForRebuild(doc.path, { ...doc, content: 'updated' });
    expect((await storage.get(doc.path))?.content).toBe('updated');
  });
  it('途中 symlink と既存の一時ファイルを拒否し、領域外を変更しない', async () => {
    const { storage, base, outside, doc } = await fixture();
    const victim = path.join(outside, 'victim');
    await writeFile(victim, 'original');
    await symlink(outside, path.join(base, 'nested'));
    await expect(storage.saveForRebuild(doc.path, doc)).rejects.toThrow(/ディレクトリ/);
    await rm(path.join(base, 'nested'));
    await mkdir(path.join(base, 'nested'));
    await symlink(victim, path.join(base, 'nested/a.md.json.tmp'));
    await expect(storage.saveForRebuild(doc.path, doc)).rejects.toThrow(/確認できません/);
    expect(await readFile(victim, 'utf8')).toBe('original');
  });
  it('同じ保存先の別利用と、保存先自体の symlink を拒否する', async () => {
    const { storage, base, outside, doc } = await fixture();
    await mkdir(path.join(base, 'nested'));
    const lockPath = path.join(base, 'nested/a.md.json.rebuild-lock');
    const lock = await open(lockPath, 'wx');
    try { await expect(storage.saveForRebuild(doc.path, doc)).rejects.toThrow(); } finally { await lock.close(); await rm(lockPath); }
    await symlink(outside, path.join(base, 'nested/a.md.json'));
    await expect(storage.saveForRebuild(doc.path, doc)).rejects.toThrow(/確認できません/);
  });
  it('同じ文書への同時保存では一方を拒否する', async () => {
    const { storage, doc } = await fixture();
    const result = await Promise.allSettled([
      storage.saveForRebuild(doc.path, doc),
      storage.saveForRebuild(doc.path, { ...doc, content: 'second' }),
    ]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(value => value.status === 'rejected')).toHaveLength(1);
  });
  it('管理領域外に出るキーを拒否する', async () => {
    const { storage, doc } = await fixture();
    await expect(storage.saveForRebuild('../outside', doc)).rejects.toThrow(/不正/);
  });
});
