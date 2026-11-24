import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertKnownIndexLayout, assertPurgeSourcesOutsideIndex } from '../../rebuild/purge-safety.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'purge-sources-'));
  roots.push(projectRoot);
  const indexPath = path.join(projectRoot, '.search-docs/index');
  await mkdir(indexPath, { recursive: true });
  return { projectRoot, indexPath, sources: ['**/*.md'] };
}
describe('削除前の元文書検査', () => {
  it('実際の LanceDB 索引と破損した manifest を既知の配置として検査する', async () => {
    const options = await fixture();
    const script = [
      'import lancedb, sys',
      'from datetime import timedelta',
      'db = lancedb.connect(sys.argv[1])',
      "table = db.create_table('sections', data=[{'id': 'a', 'document_path': 'a.md', 'vector': [1.0, 2.0]}])",
      "table.create_scalar_index('document_path', index_type='BTREE')",
      "table.create_scalar_index('id', index_type='BITMAP')",
      "table.wait_for_index(['document_path_idx', 'id_idx'], timeout=timedelta(seconds=30))",
    ].join('\n');
    await promisify(execFile)('uv', ['run', '--project', path.resolve('../db-engine'), 'python', '-c', script, options.indexPath], {
      env: { ...process.env, UV_NO_SYNC: '1', UV_CACHE_DIR: '/tmp/search-docs-uv-cache' },
    });
    await expect(assertKnownIndexLayout(options.indexPath)).resolves.toBeUndefined();
    const { readdir } = await import('node:fs/promises');
    const versions = path.join(options.indexPath, 'sections.lance', '_versions');
    const manifest = (await readdir(versions))[0];
    await writeFile(path.join(versions, manifest), 'corrupted');
    await expect(assertKnownIndexLayout(options.indexPath)).resolves.toBeUndefined();
  }, 30000);
  it('既知の配置は内容が破損していても検査でき、用途不明の項目は拒否する', async () => {
    const options = await fixture();
    const table = path.join(options.indexPath, 'sections.lance');
    await mkdir(path.join(table, '_versions'), { recursive: true });
    await mkdir(path.join(table, 'data'));
    await writeFile(path.join(table, '_versions', '1.manifest'), 'corrupted');
    await writeFile(path.join(table, 'data', '123abc.lance'), 'corrupted');
    await expect(assertKnownIndexLayout(options.indexPath)).resolves.toBeUndefined();
    await writeFile(path.join(table, 'data', 'original.txt'), 'original');
    await expect(assertKnownIndexLayout(options.indexPath)).rejects.toThrow(/判別できない.*手動復旧/);
  });
  it('未知のテーブルやリンクを拒否する', async () => {
    const options = await fixture();
    await mkdir(path.join(options.indexPath, 'other.lance'));
    await expect(assertKnownIndexLayout(options.indexPath)).rejects.toThrow(/判別できない/);
    await rm(path.join(options.indexPath, 'other.lance'), { recursive: true });
    await symlink(options.projectRoot, path.join(options.indexPath, 'sections.lance'));
    await expect(assertKnownIndexLayout(options.indexPath)).rejects.toThrow(/判別できない/);
  });
  it('通常の索引を認め、隠し・除外対象の Markdown も保護する', async () => {
    const options = await fixture();
    await mkdir(path.join(options.indexPath, 'sections.lance'));
    await expect(assertPurgeSourcesOutsideIndex(options)).resolves.toBeUndefined();
    await mkdir(path.join(options.indexPath, '.hidden'));
    await writeFile(path.join(options.indexPath, '.hidden', 'source.MD'), 'original');
    await expect(assertPurgeSourcesOutsideIndex(options)).rejects.toThrow(/文書があります/);
  });
  it('明示 glob の非 Markdown 元文書を検出する', async () => {
    const options = await fixture();
    const original = path.join(options.indexPath, 'original.txt');
    await writeFile(original, 'original');
    await expect(assertPurgeSourcesOutsideIndex({ ...options, sources: [original] })).rejects.toThrow(/元文書/);
  });
  it('索引内リンクと削除対象を参照する外部リンクを拒否する', async () => {
    const options = await fixture();
    await symlink(options.projectRoot, path.join(options.indexPath, 'link'));
    await expect(assertPurgeSourcesOutsideIndex(options)).rejects.toThrow(/リンク/);
    await rm(path.join(options.indexPath, 'link'));
    const original = path.join(options.indexPath, 'original.txt');
    await writeFile(original, 'original');
    await symlink(original, path.join(options.projectRoot, 'source.txt'));
    await expect(assertPurgeSourcesOutsideIndex({ ...options, sources: ['source.txt'] })).rejects.toThrow(/元文書/);
  });
});
