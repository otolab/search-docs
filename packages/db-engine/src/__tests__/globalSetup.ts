import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

let embeddingServer: ChildProcess | null = null;
const EMBEDDING_PORT = 18080;

async function waitForServer(url: string, maxWaitMs = 60000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    if (embeddingServer?.exitCode !== null) {
      throw new Error(`Embedding server exited before becoming ready (code: ${embeddingServer.exitCode})`);
    }

    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Embedding server did not start within ${maxWaitMs}ms`);
}

export async function setup() {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const projectRoot = path.resolve(packageRoot, '../..');
  const script = path.join(packageRoot, 'src/python/embedding_server.py');
  const modelPath = path.join(projectRoot, '.cache/models/ruri-v3-30m-onnx');

  console.log(`Starting embedding server on port ${EMBEDDING_PORT}...`);
  embeddingServer = spawn(
    'uv',
    [
      '--project', packageRoot,
      'run', 'python', script,
      '--port', EMBEDDING_PORT.toString(),
      '--runtime', 'onnx',
      '--model-path', modelPath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TOKENIZERS_PARALLELISM: 'false' },
    },
  );

  embeddingServer.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[embedding-server] ${data}`);
  });
  embeddingServer.on('error', (error) => {
    process.stderr.write(`[embedding-server] spawn error: ${error}\n`);
  });

  await waitForServer(`http://localhost:${EMBEDDING_PORT}`);
  console.log('Embedding server ready');

  process.env.TEST_EMBEDDING_URL = `http://localhost:${EMBEDDING_PORT}`;
  process.env.EMBEDDING_URL = `http://localhost:${EMBEDDING_PORT}`;
}

export async function teardown() {
  if (embeddingServer) {
    console.log('Stopping embedding server...');
    embeddingServer.kill('SIGTERM');
    embeddingServer = null;
  }
}
