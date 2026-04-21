/**
 * Embeddingサーバ関連ユーティリティ
 */

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

interface EmbeddingHealthResponse {
  status: string;
  model: string;
  vectorDimension: number;
}

export async function checkEmbeddingHealth(
  host: string,
  port: number,
  timeout: number = 3000,
): Promise<EmbeddingHealthResponse | null> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as EmbeddingHealthResponse;
    return data.status === 'ok' ? data : null;
  } catch {
    return null;
  }
}

export async function waitForEmbeddingReady(
  host: string,
  port: number,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await checkEmbeddingHealth(host, port, 2000);
    if (health) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function embeddingDir(): string {
  return path.join(os.homedir(), '.search-docs');
}

export function embeddingPidPath(): string {
  return path.join(embeddingDir(), 'embedding.pid');
}

export function embeddingLogPath(): string {
  return path.join(embeddingDir(), 'embedding.log');
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}
