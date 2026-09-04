/**
 * Embeddingサーバ関連ユーティリティ
 */

import * as os from 'os';
import * as path from 'path';
import { isPortAvailable as checkPortAvailable, isProcessAlive } from './process.js';

export const DEFAULT_EMBEDDING_PORT = 24281;

export interface EmbeddingLastProbe {
  at: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

/**
 * /health の既存フィールドに加えて、サーバ側自己プローブの状態を保持する。
 * 追加フィールドは optional にして旧バージョンのサーバにも接続できるようにする。
 */
export interface EmbeddingHealthResponse {
  status: string;
  model: string;
  vectorDimension: number;
  ready?: boolean;
  lastProbe?: EmbeddingLastProbe | null;
  consecutiveFailures?: number;
  uptimeSeconds?: number;
  runtime?: string;
  /** CLIが計測したHTTPレイテンシ（サーバ応答には含めない）。 */
  latencyMs?: number;
}

export interface EmbeddingReadinessResponse {
  ready: boolean;
  statusCode: number;
  latencyMs: number;
  lastProbe?: EmbeddingLastProbe | null;
  consecutiveFailures?: number;
  error?: string;
}

export interface EmbeddingProbeResult {
  success: boolean;
  latencyMs: number;
  endpoint?: '/api/embed' | '/encode';
  vectorDimension?: number;
  error?: string;
}

export interface EmbeddingPidFile {
  pid: number;
  port: number;
  startedAt: string;
  model?: string;
  dimension?: number;
  logPath?: string;
}

export interface EmbeddingPidFileState {
  exists: boolean;
  value: EmbeddingPidFile | null;
  error?: string;
}

interface EmbeddingHttpResponse<T> {
  statusCode: number;
  data: T | null;
  latencyMs: number;
}

/**
 * EmbeddingサーバへJSONリクエストを送る共通処理。
 * ネットワークエラーは null、HTTPエラーは statusCode 付きで返すため、
 * /ready の 503 と接続不能を区別できる。
 */
async function requestEmbeddingJson<T>(
  host: string,
  port: number,
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = 3000,
): Promise<EmbeddingHttpResponse<T> | null> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`http://${host}:${port}${endpoint}`, {
      ...options,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const responseLike = response as Response & {
      text?: () => Promise<string>;
      json?: () => Promise<unknown>;
    };
    const statusCode = typeof responseLike.status === 'number'
      ? responseLike.status
      : responseLike.ok ? 200 : 500;
    let data: T | null = null;
    if (typeof responseLike.text === 'function') {
      const body = await responseLike.text();
      try {
        if (body) data = JSON.parse(body) as T;
      } catch {
        // HTTP応答自体は届いているため、接続不能とは区別して返す。
      }
    } else if (typeof responseLike.json === 'function') {
      try {
        data = await responseLike.json() as T;
      } catch {
        // HTTP応答自体は届いているため、接続不能とは区別して返す。
      }
    }
    return {
      statusCode,
      data,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return null;
  }
}

function isHealthResponse(data: unknown): data is EmbeddingHealthResponse {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<EmbeddingHealthResponse>;
  return (
    typeof value.status === 'string' &&
    typeof value.model === 'string' &&
    typeof value.vectorDimension === 'number'
  );
}

/**
 * liveness確認。status が degraded でもHTTPサーバとモデルは生きているため、
 * 後方互換のためレスポンスを返す。
 */
export async function checkEmbeddingHealth(
  host: string,
  port: number,
  timeout: number = 3000,
): Promise<EmbeddingHealthResponse | null> {
  const result = await requestEmbeddingJson<EmbeddingHealthResponse>(
    host,
    port,
    '/health',
    undefined,
    timeout,
  );
  if (!result || result.statusCode < 200 || result.statusCode >= 300 || !isHealthResponse(result.data)) {
    return null;
  }
  return { ...result.data, latencyMs: result.latencyMs };
}

/**
 * HTTPエンドポイントが応答可能かを確認する。JSONの形式やHTTPステータスに
 * 依存しないため、停止後検証で利用する。
 */
export async function isEmbeddingHealthReachable(
  host: string,
  port: number,
  timeout: number = 1000,
): Promise<boolean> {
  return (await requestEmbeddingJson<unknown>(host, port, '/health', undefined, timeout)) !== null;
}

/**
 * /ready を優先してreadinessを確認する。旧サーバで/readyがない場合は
 * /health の status/ready を使って後方互換を保つ。
 */
export async function checkEmbeddingReadiness(
  host: string,
  port: number,
  timeout: number = 3000,
): Promise<EmbeddingReadinessResponse | null> {
  const readyResult = await requestEmbeddingJson<{
    ready?: boolean;
    lastProbe?: EmbeddingLastProbe | null;
    consecutiveFailures?: number;
    error?: string;
  }>(host, port, '/ready', undefined, timeout);

  if (readyResult && readyResult.statusCode !== 404) {
    const data = readyResult.data;
    return {
      ready: readyResult.statusCode >= 200 && readyResult.statusCode < 300 &&
        data?.ready === true,
      statusCode: readyResult.statusCode,
      latencyMs: readyResult.latencyMs,
      lastProbe: data?.lastProbe,
      consecutiveFailures: data?.consecutiveFailures,
      error: data?.error,
    };
  }

  const health = await checkEmbeddingHealth(host, port, timeout);
  if (!health) return null;
  return {
    ready: health.ready ?? health.status === 'ok',
    statusCode: 200,
    latencyMs: health.latencyMs ?? 0,
    lastProbe: health.lastProbe,
    consecutiveFailures: health.consecutiveFailures,
  };
}

function extractVector(data: unknown, field: 'embeddings' | 'vectors'): number[] | null {
  if (!data || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return null;
  const vector = Array.isArray(value[0]) ? value[0] : value;
  if (!Array.isArray(vector) || vector.length === 0) return null;
  return vector.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? vector as number[]
    : null;
}

function validateProbeResponse(
  data: unknown,
  field: 'embeddings' | 'vectors',
  expectedDimension?: number,
): { valid: boolean; vectorDimension?: number; error?: string } {
  const vector = extractVector(data, field);
  if (!vector) return { valid: false, error: 'response did not contain a numeric vector' };
  if (expectedDimension && vector.length !== expectedDimension) {
    return {
      valid: false,
      vectorDimension: vector.length,
      error: `unexpected vector dimension (expected ${expectedDimension}, got ${vector.length})`,
    };
  }
  return { valid: true, vectorDimension: vector.length };
}

/**
 * 実際の推論パスを確認する。Ollama互換APIを優先し、旧実装や簡易モック向けに
 * /encode へフォールバックする。
 */
export async function probeEmbedding(
  host: string,
  port: number,
  timeout: number = 3000,
  expectedDimension?: number,
  text: string = 'search-docs health probe',
): Promise<EmbeddingProbeResult> {
  const body = JSON.stringify({
    model: 'ruri',
    input: [text],
    ...(expectedDimension ? { dimensions: expectedDimension } : {}),
  });
  const apiEmbed = await requestEmbeddingJson<unknown>(host, port, '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, timeout);
  if (apiEmbed) {
    const validation = apiEmbed.statusCode >= 200 && apiEmbed.statusCode < 300
      ? validateProbeResponse(apiEmbed.data, 'embeddings', expectedDimension)
      : { valid: false, error: `HTTP ${apiEmbed.statusCode}` };
    if (validation.valid) {
      return {
        success: true,
        latencyMs: apiEmbed.latencyMs,
        endpoint: '/api/embed',
        vectorDimension: validation.vectorDimension,
      };
    }
  }

  const encodeBody = JSON.stringify({
    texts: [text],
    ...(expectedDimension ? { dimension: expectedDimension } : {}),
  });
  const encode = await requestEmbeddingJson<unknown>(host, port, '/encode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: encodeBody,
  }, timeout);
  if (encode) {
    const validation = encode.statusCode >= 200 && encode.statusCode < 300
      ? validateProbeResponse(encode.data, 'vectors', expectedDimension)
      : { valid: false, error: `HTTP ${encode.statusCode}` };
    if (validation.valid) {
      return {
        success: true,
        latencyMs: encode.latencyMs,
        endpoint: '/encode',
        vectorDimension: validation.vectorDimension,
      };
    }
    return {
      success: false,
      latencyMs: encode.latencyMs,
      error: validation.error ?? 'embedding probe failed',
    };
  }

  return {
    success: false,
    latencyMs: apiEmbed?.latencyMs ?? 0,
    error: apiEmbed ? 'embedding probe failed' : 'embedding server did not respond',
  };
}

export async function waitForEmbeddingReady(
  host: string,
  port: number,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const readiness = await checkEmbeddingReadiness(host, port, 2000);
    if (readiness?.ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
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

export async function readEmbeddingPidFile(
  pidPath: string = embeddingPidPath(),
): Promise<EmbeddingPidFileState> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(pidPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<EmbeddingPidFile>;
    if (
      typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535 ||
      typeof parsed.startedAt !== 'string'
    ) {
      return { exists: true, value: null, error: 'PID file has an invalid schema' };
    }
    return {
      exists: true,
      value: {
        pid: parsed.pid,
        port: parsed.port,
        startedAt: parsed.startedAt,
        model: parsed.model,
        dimension: parsed.dimension,
        logPath: parsed.logPath,
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { exists: false, value: null };
    if (error instanceof SyntaxError) {
      return { exists: true, value: null, error: 'PID file contains invalid JSON' };
    }
    return { exists: true, value: null, error: (error as Error).message };
  }
}

export async function removeEmbeddingPidFile(
  pidPath: string = embeddingPidPath(),
): Promise<void> {
  const { unlink } = await import('fs/promises');
  await unlink(pidPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/**
 * ポートが利用可能か確認する。既存のexportを維持する。
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return checkPortAvailable(port);
}

export interface EmbeddingStopVerification {
  processExited: boolean;
  portReleased: boolean;
  healthUnreachable: boolean;
}

/**
 * 停止処理が実効したことを、プロセス・ポート・HTTPの3面から確認する。
 */
export async function verifyEmbeddingStopped(
  host: string,
  port: number,
  pid: number | null,
  timeoutMs: number = 5000,
): Promise<EmbeddingStopVerification> {
  const deadline = Date.now() + timeoutMs;
  let result: EmbeddingStopVerification = {
    processExited: pid === null || !isProcessAlive(pid),
    portReleased: await isPortAvailable(port),
    healthUnreachable: !(await isEmbeddingHealthReachable(host, port, 500)),
  };

  while (Date.now() < deadline && !(result.processExited && result.portReleased && result.healthUnreachable)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = {
      processExited: pid === null || !isProcessAlive(pid),
      portReleased: await isPortAvailable(port),
      healthUnreachable: !(await isEmbeddingHealthReachable(host, port, 500)),
    };
  }
  return result;
}

// 状態モデルを従来のembeddingユーティリティからも参照できるようにする。
// type-only exportなので実行時の循環依存は発生しない。
export type { EmbeddingCheck, EmbeddingOverallState } from './embedding-state.js';
