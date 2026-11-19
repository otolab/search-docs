import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DBEngine } from '@search-docs/db-engine';
import type { FileStorage } from '@search-docs/storage';
import type { FileDiscovery } from '../discovery/file-discovery.js';
import type { DocumentQueue } from '../worker/document-queue.js';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reconcile only candidates whose absence and managed storage boundary are verifiable. */
export async function reconcileStartup(options: {
  root: string;
  storage: FileStorage;
  db: DBEngine;
  discovery: FileDiscovery;
  queue: DocumentQueue;
  covered: (filePath: string) => boolean;
  active: () => boolean;
  report: (message: string) => void;
}): Promise<void> {
  const { root, storage, db, discovery, queue, covered, active, report } = options;
  let candidates: Set<string>;
  let managedRoot: string;
  try {
    managedRoot = await fs.realpath(storage.getBasePath());
    await discovery.loadGitignore();
    const [stored, indexed, requests] = await Promise.all([
      storage.list({ strict: true }), db.getIndexedPaths(),
      db.getPathsWithStatus(['pending', 'processing']),
    ]);
    candidates = new Set([...stored, ...indexed, ...requests]);
  } catch (error) {
    report(`起動時照合を保留しました: ${error instanceof Error ? error.message : '走査に失敗'}`);
    return;
  }

  for (const candidate of candidates) {
    if (!active()) return;
    await queue.run(candidate, async () => {
      if (!active()) return;
      try {
        if (path.isAbsolute(candidate) || candidate.includes('\\') || candidate.split(/[\\/]/).includes('..') || discovery.shouldIgnore(candidate) || !covered(candidate)) {
          report(`起動時照合を保留しました: ${candidate}（監視範囲を確認できません）`);
          return;
        }
        const source = path.resolve(root, candidate);
        if (!inside(path.resolve(root), source)) throw new Error('元文書の範囲外');
        const parent = await fs.realpath(path.dirname(source));
        if (!(await fs.stat(parent)).isDirectory()) throw new Error('元文書の親がディレクトリではありません');
        const destination = path.resolve(storage.getBasePath(), `${candidate}.json`);
        if (!inside(path.resolve(storage.getBasePath()), destination)) throw new Error('保存領域の範囲外');
        const destinationParent = await fs.realpath(path.dirname(destination));
        if (!inside(managedRoot, destinationParent)) throw new Error('保存領域の範囲外へのリンク');
        const expectedDestinationParent = path.resolve(managedRoot, path.relative(path.resolve(storage.getBasePath()), path.dirname(destination)));
        if (destinationParent !== expectedDestinationParent) throw new Error('保存先の親がシンボリックリンクを含むため保留');
        try {
          const stat = await fs.lstat(source);
          if (stat.isSymbolicLink()) {
            try { await fs.realpath(source); } catch { report(`起動時照合を保留しました: ${candidate}（リンク先を確認できません）`); }
          }
          return; // Existing files and dangling symlinks are both preserved.
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const canonicalRoot = await fs.realpath(root);
        const expectedParent = path.resolve(canonicalRoot, path.relative(path.resolve(root), path.dirname(source)));
        if (parent !== expectedParent) throw new Error('元文書の親がシンボリックリンクを含むため監視を確認できません');
        if (!active() || !covered(candidate)) return;
        // Stop stale requests before deleting their source copy or sections.
        await db.updateManyIndexRequests({ documentPath: candidate, status: 'pending' }, { status: 'skipped', completedAt: new Date().toISOString() });
        if (!active()) return;
        await db.updateManyIndexRequests({ documentPath: candidate, status: 'processing' }, { status: 'skipped', completedAt: new Date().toISOString() });
        if (!active()) return;
        await db.deleteSectionsByPath(candidate);
        if (!active()) return;
        await storage.delete(candidate);
      } catch (error) {
        report(`起動時照合を保留しました: ${candidate}（${error instanceof Error ? error.message : '確認に失敗'}）`);
      }
    });
  }
}
