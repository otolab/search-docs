import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 既知の LanceDB 配置以外は削除しない。内容の所有者を証明するものではないため、
 * 利用者による専用領域の確認と、非協調プロセスの停止が別途必要。
 */
export async function assertKnownIndexLayout(indexPath: string): Promise<void> {
  const tables = new Set(['sections.lance', 'index_requests.lance', 'writer_heartbeat.lance', 'embedding_identity.lance']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const allowed = (parts: string[], directory: boolean): boolean => {
    if (parts.length === 1) return directory && tables.has(parts[0]);
    if (!tables.has(parts[0])) return false;
    if (parts.length === 2) return directory && ['data', '_versions', '_transactions', '_indices'].includes(parts[1]);
    if (parts.length === 3 && !directory) {
      if (parts[1] === 'data') return /^[0-9a-f]+\.lance$/i.test(parts[2]);
      if (parts[1] === '_versions') return /^\d+\.manifest$/.test(parts[2]);
      if (parts[1] === '_transactions') return /^\d+-[0-9a-f-]+\.txn$/i.test(parts[2]);
    }
    if (parts[1] === '_indices' && parts.length === 3) return directory && uuid.test(parts[2]);
    if (parts[1] === '_indices' && parts.length === 4 && uuid.test(parts[2]) && !directory) {
      return ['page_data.lance', 'page_lookup.lance', 'bitmap.lance', 'bitmap_page_lookup.lance'].includes(parts[3]);
    }
    return false;
  };
  const walk = async (directory: string, parts: string[]): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = [...parts, entry.name];
      if ((!entry.isDirectory() && !entry.isFile()) || !allowed(next, entry.isDirectory())) {
        throw new Error(`削除対象に判別できない項目があります: ${path.join(indexPath, ...next)}。削除せず、全利用プロセスを停止して対象を確認し、手動復旧してください。確認できなければ管理者に相談してください。`);
      }
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), next);
    }
  };
  try {
    const info = await lstat(indexPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`削除対象が通常のディレクトリではありません: ${indexPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  await walk(indexPath, []);
}

/** 検証・排他の後に呼ぶ。index 自体はマウントポイントの可能性があるため残す。 */
export async function clearIndexContents(indexPath: string): Promise<void> {
  let entries: string[];
  try {
    const info = await lstat(indexPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`削除対象が通常のディレクトリではありません: ${indexPath}`);
    entries = await readdir(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) await rm(path.join(indexPath, entry), { recursive: true });
}

/** 削除前の排他下で実行する。確認不能なリンクや文書を拒否する。 */
export async function assertPurgeSourcesOutsideIndex(options: {
  projectRoot: string; indexPath: string; sources: string[];
}): Promise<void> {
  const root = await realpath(options.projectRoot);
  const index = path.resolve(root, options.indexPath);
  let indexExists = true;
  try {
    const info = await lstat(index);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`削除対象が通常のディレクトリではありません: ${index}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    indexExists = false;
  }
  const indexReal = indexExists ? await realpath(index) : path.join(await realpath(path.dirname(index)), path.basename(index));
  if (inside(indexReal, root)) throw new Error('削除対象にプロジェクトルートが含まれます');
  if (indexExists) {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`削除対象にリンクがあります: ${target}`);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) throw new Error(`削除対象に文書があります: ${target}`);
        else if (!entry.isFile()) throw new Error(`削除対象に確認できない項目があります: ${target}`);
      }
    };
    await walk(indexReal);
  }
  for (const pattern of options.sources.filter(value => !value.startsWith('!'))) {
    const matches = await fg(pattern, { cwd: root, absolute: true, onlyFiles: true, dot: true, followSymbolicLinks: true, suppressErrors: false });
    for (const match of matches) {
      const actual = await realpath(match);
      if (inside(indexReal, actual)) throw new Error(`削除対象に元文書があります: ${match}`);
    }
  }
  await assertKnownIndexLayout(indexReal);
}
