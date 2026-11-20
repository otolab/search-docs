import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rmdir, lstat, open } from 'node:fs/promises';
import * as path from 'node:path';

/** 同一の管理領域を参照するプロセスを調停する。残存ロックは自動削除しない。 */
export class MaintenanceLock {
  private readonly gate: string;
  private readonly users: string;
  private readonly exclusive: string;
  private readonly incomplete: string;

  constructor(private readonly directory: string) {
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
    await this.withGate(async () => {
      if (await this.exists(this.exclusive)) throw new Error('保守操作が実行中です');
      if (await this.exists(this.incomplete)) throw new Error('前回の保守操作が未完了です。復旧が必要です');
      await mkdir(registration);
    });
    let released = false;
    return async () => {
      if (released) return;
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
