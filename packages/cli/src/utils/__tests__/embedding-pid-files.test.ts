import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  embeddingPidPath,
  embeddingPidPathForPort,
  readEmbeddingPidFileForPort,
  readUniqueEmbeddingPidFile,
} from '../embedding.js';

let temporaryHome: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
  temporaryHome = undefined;
});

async function useTemporaryHome(): Promise<string> {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'embedding-pid-files-'));
  vi.stubEnv('HOME', temporaryHome);
  await mkdir(path.join(temporaryHome, '.search-docs'));
  return path.join(temporaryHome, '.search-docs');
}

function pidFile(port: number, pid: number, launchId?: string) {
  return {
    pid,
    port,
    startedAt: '2026-11-28T00:00:00.000Z',
    ...(launchId ? { launchId } : {}),
  };
}

describe('embedding PID file selection', () => {
  it('reads the old single-file format for its recorded port', async () => {
    const directory = await useTemporaryHome();
    await writeFile(embeddingPidPath(), JSON.stringify(pidFile(24281, 1111)));

    const selected = await readEmbeddingPidFileForPort(24281);
    const otherPort = await readEmbeddingPidFileForPort(24282);

    expect(selected.value).toMatchObject({ pid: 1111, port: 24281 });
    expect(selected.legacy).toBe(true);
    expect(selected.value?.launchId).toBeUndefined();
    expect(otherPort).toMatchObject({
      exists: false,
      path: path.join(directory, 'embedding-24282.pid'),
    });
  });

  it('prefers the port-specific record and leaves other ports independently selectable', async () => {
    await useTemporaryHome();
    await writeFile(embeddingPidPath(), JSON.stringify(pidFile(24281, 1111)));
    await writeFile(
      embeddingPidPathForPort(24281),
      JSON.stringify(pidFile(24281, 2222, '01234567-89ab-cdef-0123-456789abcdef')),
    );
    await writeFile(
      embeddingPidPathForPort(24282),
      JSON.stringify(pidFile(24282, 3333, 'fedcba98-7654-3210-fedc-ba9876543210')),
    );

    const selected = await readEmbeddingPidFileForPort(24281);
    const unique = await readUniqueEmbeddingPidFile();

    expect(selected.value).toMatchObject({
      pid: 2222,
      launchId: '01234567-89ab-cdef-0123-456789abcdef',
    });
    expect(selected.legacy).toBe(false);
    expect(unique.ambiguousPorts).toEqual([24281, 24282]);
  });

  it('uses a single port-specific record when the old file is absent', async () => {
    await useTemporaryHome();
    await writeFile(
      embeddingPidPathForPort(24282),
      JSON.stringify(pidFile(24282, 3333, '01234567-89ab-cdef-0123-456789abcdef')),
    );

    const unique = await readUniqueEmbeddingPidFile();

    expect(unique.port).toBe(24282);
    expect(unique.state.value).toMatchObject({ pid: 3333, port: 24282 });
    expect(unique.ambiguousPorts).toEqual([]);
  });
});
