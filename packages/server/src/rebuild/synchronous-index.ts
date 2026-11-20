import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { UnconfirmedProcessStopError, type DBEngine } from '@search-docs/db-engine';
import type { FilesConfig, IndexingConfig } from '@search-docs/types';
import type { FileStorage } from '@search-docs/storage';
import { FileDiscovery } from '../discovery/file-discovery.js';
import { MarkdownSplitter } from '../splitter/markdown-splitter.js';

interface Source { path: string; content: string; hash: string }
export interface PreparedSources { root: string; files: FilesConfig; sources: Source[]; forbiddenPath: string }

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 削除前に全対象を読み込み、削除対象内の文書を拒否する。 */
export async function prepareSynchronousSources(options: {
  root: string; files: FilesConfig; forbiddenPath: string;
}): Promise<PreparedSources> {
  const root = await realpath(options.root);
  const configuredRoot = path.resolve(options.root);
  const files = { ...options.files, sources: options.files.sources.map(pattern => {
    const negative = pattern.startsWith('!');
    const value = negative ? pattern.slice(1) : pattern;
    if (path.isAbsolute(value) && inside(configuredRoot, value)) {
      return `${negative ? '!' : ''}${path.relative(configuredRoot, value).split(path.sep).join('/')}`;
    }
    if (!negative && !inside(configuredRoot, path.resolve(configuredRoot, value))) {
      throw new Error(`プロジェクト外の文書は再構築できません: ${pattern}。削除前の確認で検出した場合は削除しません。全利用プロセスを停止し、設定と削除対象を確認してから手動復旧してください。確認できなければ管理者に相談してください。`);
    }
    return pattern;
  }), exclude: options.files.exclude.map(pattern =>
    path.isAbsolute(pattern) && inside(configuredRoot, pattern)
      ? path.relative(configuredRoot, pattern).split(path.sep).join('/')
      : pattern
  ) };
  const discovery = new FileDiscovery({ rootDir: root, config: files });
  const found = await discovery.findFiles();
  const sources: Source[] = [];
  const keys = new Map<string, string>();
  for (const file of [...new Set(found)].sort()) {
    const full = await realpath(path.resolve(root, file));
    if (!inside(root, full)) {
      throw new Error(`プロジェクト外の文書は再構築できません: ${file}。削除前の確認で検出した場合は削除しません。全利用プロセスを停止し、設定と削除対象を確認してから手動復旧してください。確認できなければ管理者に相談してください。`);
    }
    if (inside(options.forbiddenPath, full)) throw new Error(`安全でない文書パスです: ${file}`);
    const key = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    // FileStorage は絶対キーも basePath 配下に展開するため、相対キーと衝突し得る。
    const storageKey = path.join('/', key);
    if (keys.has(storageKey) && keys.get(storageKey) !== full) throw new Error(`文書キーが衝突します: ${file}`);
    if (keys.has(storageKey)) continue;
    keys.set(storageKey, full);
    const info = await stat(full);
    if (!info.isFile() || info.size > files.maxFileSize) throw new Error(`文書を索引化できません: ${file}`);
    const content = await readFile(full, 'utf8');
    sources.push({ path: key, content, hash: createHash('sha256').update(content).digest('hex') });
  }
  sources.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, sources, forbiddenPath: options.forbiddenPath };
}

/** 呼び出し元が排他を保持する。完了前に DB 子プロセスの停止まで待機する。 */
export async function indexSynchronousSources(options: {
  prepared: PreparedSources; engine: DBEngine; storage: FileStorage; indexing: IndexingConfig;
}): Promise<void> {
  let failure: unknown;
  try {
    await options.engine.connect();
    const splitter = new MarkdownSplitter(options.indexing);
    for (const source of options.prepared.sources) {
      const now = new Date();
      await options.storage.saveForRebuild(source.path, { path: source.path, content: source.content, metadata: { createdAt: now, updatedAt: now, fileHash: source.hash } });
      const sections = splitter.split(source.content, source.path, source.hash);
      const result = await options.engine.addSections(sections, { rejectSkipped: true });
      if (result.count !== sections.length) throw new Error(`索引化件数が一致しません: ${source.path}`);
      for (const section of sections) {
        const saved = await options.engine.getSectionById(section.id);
        if (!saved.section || saved.section.documentPath !== source.path || saved.section.documentHash !== source.hash) {
          throw new Error(`索引の確認に失敗しました: ${source.path}`);
        }
      }
    }
    const current = await prepareSynchronousSources(options.prepared);
    if (JSON.stringify(current.sources.map(s => [s.path, s.hash])) !== JSON.stringify(options.prepared.sources.map(s => [s.path, s.hash]))) {
      throw new Error('索引化中に対象文書が変更されました');
    }
  } catch (error) { failure = error; }
  try { await options.engine.disconnect(); } catch (error) {
    throw new UnconfirmedProcessStopError(failure ? new AggregateError([failure, error], '索引化と DB の停止に失敗しました') : error);
  }
  if (failure) throw failure instanceof Error ? failure : new Error('索引化に失敗しました', { cause: failure });
}
