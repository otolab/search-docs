import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MaintenanceLock } from '@search-docs/db-engine';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
vi.mock('@search-docs/config', () => ({ ConfigLoader: { resolve: mocks.resolve } }));
vi.mock('@search-docs/db-engine', async importOriginal => {
  const actual = await importOriginal<typeof import('@search-docs/db-engine')>();
  return { ...actual, DBEngine: class { connect = mocks.connect; disconnect = mocks.disconnect; } };
});
vi.mock('@search-docs/server', () => ({
  assertPurgeSourcesOutsideIndex: vi.fn(async () => {}),
  clearIndexContents: mocks.clear,
  prepareEmbeddingOptions: vi.fn(),
  EmbeddingServerProcess: class { start = mocks.start; stop = mocks.stop; },
}));
import { executeIndexPurge } from '../index/purge.js';

const temporary: string[] = [];
const oldExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = oldExitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cli-purge-safety-'));
  temporary.push(root);
  await mkdir(path.join(root, '.search-docs/index'), { recursive: true });
  await mkdir(path.join(root, '.search-docs/documents'));
  const document = path.join(root, '.search-docs/documents/copy.md');
  await writeFile(document, 'keep');
  mocks.resolve.mockResolvedValue({ projectRoot: root, config: {
    storage: { indexPath: '.search-docs/index', documentsPath: '.search-docs/documents' },
    files: { sources: ['docs/**/*.md'] }, indexing: { vectorDimension: 256 }, worker: {},
  } });
  mocks.start.mockResolvedValue('http://localhost:1234');
  mocks.clear.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const lock = new MaintenanceLock(path.join(root, '.search-docs/.search-docs-maintenance'));
  return { lock, document };
}
describe.skipIf(process.platform === 'win32')('CLI purge の失敗時保全', () => {
  it('初期化失敗時は文書コピーと未完了マーカーを残す', async () => {
    const { lock, document } = await fixture();
    mocks.connect.mockRejectedValue(new Error('init failed'));
    await executeIndexPurge({ confirmIsolated: true });
    expect(process.exitCode).toBe(1);
    expect(await readFile(document, 'utf8')).toBe('keep');
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalled();
    await expect(lock.acquireShared()).rejects.toThrow(/未完了/);
  });
  it('停止失敗時は未完了マーカーと排他を保持する', async () => {
    const { lock, document } = await fixture();
    mocks.disconnect.mockRejectedValue(new Error('stop failed'));
    await executeIndexPurge({ confirmIsolated: true });
    expect(process.exitCode).toBe(1);
    expect(await readFile(document, 'utf8')).toBe('keep');
    expect(mocks.stop).toHaveBeenCalled();
    await expect(lock.acquireShared()).rejects.toThrow(/保守操作/);
    await expect(lock.acquireExclusive()).rejects.toThrow(/保守操作/);
  });
});
