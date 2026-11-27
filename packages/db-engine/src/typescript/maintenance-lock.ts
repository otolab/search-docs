import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rmdir, lstat, open, realpath, readFile, writeFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { FilesConfig } from '@search-docs/types';

/** 同一の管理領域を参照するプロセスを調停する。残存ロックは自動削除しない。 */
export class MaintenanceLock {
  private readonly gate: string;
  private readonly users: string;
  private readonly exclusive: string;
  private readonly incomplete: string;

  constructor(private readonly directory: string, private readonly identity?: string) {
    this.gate = path.join(directory, 'gate');
    this.users = path.join(directory, 'users');
    this.exclusive = path.join(directory, 'exclusive');
    this.incomplete = path.join(directory, 'incomplete');
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('管理領域がディレクトリではないか、シンボリックリンクです');
    await mkdir(this.users, { recursive: true });
    const usersStat = await lstat(this.users);
    if (!usersStat.isDirectory() || usersStat.isSymbolicLink()) throw new Error('利用登録領域が不正です');
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async withGate<T>(action: () => Promise<T>): Promise<T> {
    await this.initialize();
    const deadline = Date.now() + 1000;
    while (true) {
      try {
        await mkdir(this.gate);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('管理領域は使用中です。残存ロックの可能性もあります');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      return await action();
    } finally {
      await rmdir(this.gate);
    }
  }

  async acquireShared(): Promise<() => Promise<void>> {
    const registration = path.join(this.users, randomUUID());
    const identityPath = path.join(registration, 'identity');
    await this.withGate(async () => {
      if (await this.exists(this.exclusive)) throw new Error('保守操作が実行中です');
      if (await this.exists(this.incomplete)) throw new Error('前回の保守操作が未完了です。復旧が必要です');
      if (this.identity) {
        for (const user of await readdir(this.users)) {
          let existing: string;
          try { existing = await readFile(path.join(this.users, user, 'identity'), 'utf8'); }
          catch { throw new Error('他の利用者の設定を確認できません。全プロセスを停止して確認してください'); }
          if (existing !== this.identity) throw new Error('同じ保存先に異なるプロジェクト設定の利用者がいます');
        }
      }
      await mkdir(registration);
      if (this.identity) {
        try { await writeFile(identityPath, this.identity, { flag: 'wx', mode: 0o600 }); }
        catch (error) { await rmdir(registration); throw error; }
      }
    });
    let released = false;
    return async () => {
      if (released) return;
      if (this.identity) await unlink(identityPath);
      await rmdir(registration);
      released = true;
    };
  }

  /** 未完了マーカーが残っていても、他の利用者がいなければ再試行できる。 */
  async acquireExclusive(options: { requireComplete?: boolean } = {}): Promise<ExclusiveMaintenance> {
    await this.withGate(async () => {
      if (await this.exists(this.exclusive)) throw new Error('保守操作が実行中です');
      if ((await readdir(this.users)).length > 0) throw new Error('データを使用中のプロセスがあります');
      if (options.requireComplete && await this.exists(this.incomplete)) throw new Error('前回の保守操作が未完了です。復旧が必要です');
      await mkdir(this.exclusive);
    });
    return new ExclusiveMaintenance(this.exclusive, this.incomplete);
  }
}

/** strict 起動では保守操作と同じ標準配置・管理領域を使用する。 */
export async function strictMaintenanceLock(options: {
  projectRoot: string;
  indexPath: string;
  documentsPath: string;
  files: FilesConfig;
}): Promise<MaintenanceLock> {
  const guidance = '全 search-docs プロセスを停止し、設定と保存先を確認してバックアップしてください。データを削除せず管理者に相談してください。';
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error(`この環境では保存先の調停を確認できません。${guidance}`);
  const root = await realpath(options.projectRoot);
  const index = path.resolve(root, options.indexPath);
  const documents = path.resolve(root, options.documentsPath);
  if (path.basename(index) !== 'index' || path.basename(documents) !== 'documents' || path.dirname(index) !== path.dirname(documents)) {
    throw new Error(`保存先が標準の兄弟配置ではありません。${guidance}`);
  }
  const parent = path.dirname(index);
  let parentDevice: number | undefined;
  // 未作成の標準ディレクトリは管理登録が作成する。存在する親の実体を検査する。
  try {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`保存先の親が通常のディレクトリではありません。${guidance}`);
    parentDevice = parentStat.dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const candidate of [index, documents, path.join(parent, '.search-docs-maintenance')]) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`保存先が通常のディレクトリではありません: ${candidate}。${guidance}`);
      if (parentDevice !== undefined && stat.dev !== parentDevice) throw new Error(`保存先が親と異なる filesystem です: ${candidate}。${guidance}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let canonicalParent: string;
  try { canonicalParent = await realpath(parent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // 未作成の親の直上は存在し、symlink の別名を解決できる場合だけ許可する。
    canonicalParent = path.join(await realpath(path.dirname(parent)), path.basename(parent));
  }
  const files = {
    sources: options.files.sources,
    exclude: options.files.exclude,
    respectGitignore: options.files.respectGitignore ?? options.files.ignoreGitignore ?? true,
    maxFileSize: options.files.maxFileSize,
  };
  const identity = JSON.stringify({ root, index: path.join(canonicalParent, 'index'), documents: path.join(canonicalParent, 'documents'), files });
  return new MaintenanceLock(path.join(canonicalParent, '.search-docs-maintenance'), identity);
}

export class ExclusiveMaintenance {
  private released = false;
  private completionUncertain = false;

  constructor(private readonly exclusive: string, private readonly incomplete: string) {}

  async markIncomplete(): Promise<void> {
    if (this.released) throw new Error('保守ロックは解放済みです');
    // 管理ディレクトリ自体が今回作られた場合も、その親への登録を同期する。
    await syncDirectory(path.dirname(path.dirname(this.incomplete)));
    try {
      await mkdir(this.incomplete);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await lstat(this.incomplete);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('未完了マーカーが不正です');
    }
    await syncDirectory(path.dirname(this.incomplete));
  }

  async complete(): Promise<void> {
    if (this.released) throw new Error('保守ロックは解放済みです');
    await rmdir(this.incomplete);
    try {
      await syncDirectory(path.dirname(this.incomplete));
    } catch (error) {
      // マーカー削除の永続性が不明なら排他を残して通常利用を遮断する。
      this.completionUncertain = true;
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (this.completionUncertain) throw new Error('完了状態を同期できないため保守ロックを保持します');
    await rmdir(this.exclusive);
    this.released = true;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** 標準配置に限り共有登録する。非標準配置と Windows は調停対象外。 */
export async function acquireStandardStorageRegistration(options: {
  projectRoot: string;
  indexPath: string;
  documentsPath: string;
}): Promise<(() => Promise<void>) | null> {
  if (process.platform === 'win32') return null;
  const index = path.resolve(options.projectRoot, options.indexPath);
  const documents = path.resolve(options.projectRoot, options.documentsPath);
  if (path.basename(index) !== 'index' || path.basename(documents) !== 'documents' || path.dirname(index) !== path.dirname(documents)) return null;
  return new MaintenanceLock(path.join(path.dirname(index), '.search-docs-maintenance')).acquireShared();
}
