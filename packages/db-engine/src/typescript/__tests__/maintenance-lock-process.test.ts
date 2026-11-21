import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { MaintenanceLock } from '../maintenance-lock.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'maintenance-process-'));
  roots.push(root);
  const source = await readFile(fileURLToPath(new URL('../maintenance-lock.ts', import.meta.url)), 'utf8');
  const modulePath = path.join(root, 'maintenance-lock.mjs');
  await writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  return { directory: path.join(root, 'control'), moduleUrl: pathToFileURL(modulePath).href };
}
async function startHolder(moduleUrl: string, directory: string, mode: 'shared' | 'exclusive') {
  const script = `import { MaintenanceLock } from ${JSON.stringify(moduleUrl)};
const lock = new MaintenanceLock(process.argv[1]);
const held = await lock.${mode === 'shared' ? 'acquireShared' : 'acquireExclusive'}();
${mode === 'exclusive' ? 'await held.markIncomplete();' : ''}
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const [data] = await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('子プロセスが取得前に終了しました'); }),
  ]);
  expect(String(data)).toContain('ready');
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('実プロセス間の保守ロック', () => {
  it('別プロセスの共有利用と強制終了後の残存登録は排他取得を妨げる', async () => {
    const { directory, moduleUrl } = await fixture();
    const child = await startHolder(moduleUrl, directory, 'shared');
    const lock = new MaintenanceLock(directory);
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
    child.kill('SIGKILL');
    await once(child, 'exit');
    await expect(lock.acquireExclusive()).rejects.toThrow(/使用中/);
  });

  it('別プロセスの保守中と強制終了後は通常利用を拒否する', async () => {
    const { directory, moduleUrl } = await fixture();
    const child = await startHolder(moduleUrl, directory, 'exclusive');
    const lock = new MaintenanceLock(directory);
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    child.kill('SIGKILL');
    await once(child, 'exit');
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    await rmdir(path.join(directory, 'exclusive'));
    await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
    const retry = await lock.acquireExclusive();
    await retry.markIncomplete();
    await retry.complete();
    await retry.release();
    const release = await lock.acquireShared();
    await release();
  });
});
