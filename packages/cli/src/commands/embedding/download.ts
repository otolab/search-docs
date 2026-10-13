/**
 * embedding download command
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { resolveDbEngineRoot } from '../../utils/db-engine-path.js';

export interface EmbeddingDownloadOptions {
  runtime?: 'onnx' | 'torch';
}

export async function downloadEmbeddingModel(options: EmbeddingDownloadOptions): Promise<void> {
  const runtime = options.runtime ?? 'onnx';
  if (runtime !== 'onnx' && runtime !== 'torch') {
    throw new Error(`Invalid runtime: ${String(runtime)}. Expected "onnx" or "torch".`);
  }

  const dbEngineRoot = resolveDbEngineRoot();
  const scriptPath = path.join(dbEngineRoot, 'src/python/embedding_server.py');
  const args = [
    '--project', dbEngineRoot, 'run', 'python',
    scriptPath,
    '--download-only',
    `--runtime=${runtime}`,
  ];

  console.log(`Downloading the default ${runtime} embedding model...`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('uv', args, {
      stdio: 'inherit',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    proc.once('error', reject);
    proc.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `Embedding model download failed${signal ? ` (signal ${signal})` : ` (exit code ${code})`}.`,
        ));
      }
    });
  });
}

export async function executeEmbeddingDownload(options: EmbeddingDownloadOptions): Promise<void> {
  try {
    await downloadEmbeddingModel(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exitCode = 1;
  }
}
