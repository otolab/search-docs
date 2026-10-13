import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadEmbeddingModel } from '../download.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('embedding download', () => {
  it('runs the Python downloader for the selected runtime without starting the server', async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const download = downloadEmbeddingModel({ runtime: 'onnx' });
    expect(spawnMock).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        expect.stringMatching(/embedding_server\.py$/),
        '--download-only',
        '--runtime=onnx',
      ]),
      expect.objectContaining({ stdio: 'inherit' }),
    );
    child.emit('close', 0, null);
    await download;
  });

  it('uses the selected runtime and reports a failed download', async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const download = downloadEmbeddingModel({
      runtime: 'torch',
    });
    expect(spawnMock.mock.calls[0][1]).toContain('--runtime=torch');
    child.emit('close', 1, null);
    await expect(download).rejects.toThrow('exit code 1');
  });
});
