import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertDocumentKey, assertRelativePattern, assertSourcePath } from '../strict-path.js';

describe('strict source boundary', () => {
  it('accepts only unambiguous project-relative keys', () => {
    expect(() => assertDocumentKey('docs/a.md')).not.toThrow();
    for (const key of ['', '/docs/a.md', '../a.md', 'a/../b.md', 'a//b.md', 'C:\\a.md', 'a\\b.md', './a.md']) {
      expect(() => assertDocumentKey(key)).toThrow();
    }
  });

  it('rejects paths and patterns whose boundary cannot be resolved', () => {
    for (const pattern of ['**/*.md', './docs/*.md']) expect(() => assertRelativePattern(pattern)).not.toThrow();
    for (const pattern of ['/tmp/*.md', '../*.md', '{docs,../outside}/*.md', 'C:\\*.md', '!(x)/*.md']) {
      expect(() => assertRelativePattern(pattern)).toThrow();
    }
  });

  it('allows an internal file and rejects links to either internal or external paths', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'strict-source-'));
    try {
      const root = path.join(tmp, 'root');
      await mkdir(path.join(root, 'docs'), { recursive: true });
      await mkdir(path.join(tmp, 'outside'));
      await writeFile(path.join(root, 'docs', 'a.md'), 'a');
      await symlink(path.join(root, 'docs'), path.join(root, 'internal'));
      await symlink(path.join(tmp, 'outside'), path.join(root, 'external'));
      await expect(assertSourcePath(root, 'docs/a.md')).resolves.toBeUndefined();
      await expect(assertSourcePath(root, 'internal/a.md')).rejects.toThrow(/シンボリックリンク/);
      await expect(assertSourcePath(root, 'external/a.md')).rejects.toThrow(/シンボリックリンク/);
      await expect(assertSourcePath(root, 'missing/a.md')).resolves.toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
