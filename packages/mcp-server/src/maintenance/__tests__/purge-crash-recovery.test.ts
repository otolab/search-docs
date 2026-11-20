import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MaintenanceLock } from '@search-docs/db-engine';

describe.skipIf(process.platform === 'win32')('保守中の強制終了と復旧', () => {
  it('残存ロック除去後も、排他下の復旧完了まで通常利用を拒否する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'purge-crash-'));
    const indexPath = path.join(root, 'index');
    const documentsPath = path.join(root, 'documents');
    const managementPath = path.join(root, '.search-docs-maintenance');
    await mkdir(indexPath);
    await mkdir(documentsPath);
    await writeFile(path.join(indexPath, 'old'), 'old index');
    await writeFile(path.join(documentsPath, 'source'), 'original');
    const moduleUrl = pathToFileURL(path.resolve('dist/maintenance/exclusive-purge.js')).href;
    const script = `import { exclusivePurge } from ${JSON.stringify(moduleUrl)};
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [indexPath, documentsPath, managementPath] = process.argv.slice(1);
await exclusivePurge({ confirmed: true, validate: async () => ({ indexPath, documentsPath, managementPath }), remove: async () => {
  await rm(path.join(indexPath, 'old'));
  await writeFile(path.join(indexPath, 'partial'), 'partial');
  process.stdout.write('ready\\n');
  await new Promise(() => setInterval(() => {}, 1000));
} });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, indexPath, documentsPath, managementPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const [ready] = await Promise.race([
        once(child.stdout!, 'data'),
        once(child, 'exit').then(() => { throw new Error('保守処理の開始前に子プロセスが終了しました'); }),
      ]);
      expect(String(ready)).toContain('ready');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const lock = new MaintenanceLock(managementPath);
      await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
      await access(path.join(managementPath, 'incomplete'));
      // 実運用では全利用者・子プロセスの停止と対象の同一性を先に確認する。
      await rmdir(path.join(managementPath, 'exclusive'));
      await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
      const retry = await lock.acquireExclusive();
      await retry.markIncomplete();
      await rm(path.join(indexPath, 'partial'));
      await writeFile(path.join(indexPath, 'recovered'), 'replacement index');
      await retry.complete();
      await retry.release();
      const release = await lock.acquireShared();
      await release();
      expect(await readFile(path.join(documentsPath, 'source'), 'utf8')).toBe('original');
      expect(await readFile(path.join(indexPath, 'recovered'), 'utf8')).toBe('replacement index');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
