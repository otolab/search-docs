/**
 * Embeddingサーバの統合状態モデルと状態判定。
 */

import {
  checkEmbeddingReadiness,
  findEmbeddingHealth,
  findEmbeddingProbe,
  findEmbeddingReadiness,
  probeEmbedding,
  type EmbeddingHealthResponse,
  type EmbeddingPidFileState,
  type EmbeddingProbeResult,
  type EmbeddingReadinessResponse,
} from './embedding.js';
import {
  getListeningProcess,
  isPortAvailable,
  isProcessAlive,
  type ListeningProcess,
} from './process.js';

/** Issue #126で定義する独立したチェック項目。 */
export type EmbeddingCheck =
  | 'pid_file'
  | 'pid_alive'
  | 'port_listening'
  | 'port_owner'
  | 'health'
  | 'readiness'
  | 'embed_probe'
  | 'metadata_match';

export type EmbeddingOverallState =
  | 'healthy'
  | 'starting'
  | 'unhealthy'
  | 'degraded'
  | 'stale_pid'
  | 'orphan_process'
  | 'port_conflict'
  | 'not_running';

export type EmbeddingCheckStatus = 'ok' | 'failed' | 'unknown' | 'skipped';

export interface EmbeddingCheckResult {
  check: EmbeddingCheck;
  status: EmbeddingCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface EmbeddingStatusSnapshot {
  overallState: EmbeddingOverallState;
  host: string;
  port: number;
  pidFile: EmbeddingPidFileState;
  pidAlive: boolean;
  portListening: boolean;
  portOwner: ListeningProcess | null;
  health: EmbeddingHealthResponse | null;
  readiness: EmbeddingReadinessResponse | null;
  embedProbe: EmbeddingProbeResult | null;
  checks: EmbeddingCheckResult[];
  suggestions: string[];
  startupGraceMs: number;
}

export interface EvaluateEmbeddingStatusOptions {
  host?: string;
  port: number;
  pidFile: EmbeddingPidFileState;
  probe?: boolean;
  timeoutMs?: number;
  now?: number;
  startupGraceMs?: number;
}

const DEFAULT_STARTUP_GRACE_MS = 120_000;

function result(
  check: EmbeddingCheck,
  status: EmbeddingCheckStatus,
  message: string,
  details?: Record<string, unknown>,
): EmbeddingCheckResult {
  return { check, status, message, ...(details ? { details } : {}) };
}

function isRecentStart(startedAt: string | undefined, now: number, graceMs: number): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return now - started <= graceMs;
}

function suggestionsFor(
  state: EmbeddingOverallState,
  port: number,
  owner: ListeningProcess | null,
  pidFile: EmbeddingPidFileState,
): string[] {
  switch (state) {
    case 'healthy':
      return [];
    case 'starting':
      return ['サーバの起動処理が継続中です。しばらく待ってから status を再実行してください。'];
    case 'stale_pid':
      return [
        '古いPIDファイルを削除するには `search-docs embedding status --repair` を実行してください。',
        `再起動するには search-docs embedding start --port ${port} を実行してください。`,
      ];
    case 'unhealthy':
      return [
        'プロセスは存在しますがHTTPまたはhealthに応答していません。embedding.logを確認してください。',
        `復旧を試すには search-docs embedding stop --port ${port} && search-docs embedding start --port ${port} を実行してください。`,
      ];
    case 'degraded':
      return [
        'livenessは応答していますが推論パスまたは自己probeが失敗しています。embedding.logを確認してください。',
        `再起動を試すには search-docs embedding stop --port ${port} && search-docs embedding start --port ${port} を実行してください。`,
      ];
    case 'orphan_process':
      return [
        'PIDファイルのない外部起動サーバです。停止する場合は `embedding stop --port` を明示してください。',
      ];
    case 'port_conflict':
      return [
        owner
          ? `ポート所有者PID ${owner.pid} を確認し、必要なら search-docs embedding stop --port ${port} を実行してください。`
          : `ポート ${port} の所有プロセスを確認してから再試行してください。`,
      ];
    case 'not_running':
      return ['起動するには `search-docs embedding start` を実行してください。'];
    default:
      return pidFile.exists ? ['PIDファイルの内容を確認してください。'] : [];
  }
}

function determineState(args: {
  pidFile: EmbeddingPidFileState;
  pidAlive: boolean;
  portListening: boolean;
  owner: ListeningProcess | null;
  health: EmbeddingHealthResponse | null;
  readiness: EmbeddingReadinessResponse | null;
  probe: EmbeddingProbeResult | null;
  metadataMatches: boolean | null;
  now: number;
  startupGraceMs: number;
}): EmbeddingOverallState {
  const {
    pidFile,
    pidAlive,
    portListening,
    owner,
    health,
    readiness,
    probe,
    metadataMatches,
    now,
    startupGraceMs,
  } = args;
  const pid = pidFile.value?.pid;

  if (!pidFile.exists || !pidFile.value) {
    if (health) return 'orphan_process';
    if (portListening) return 'port_conflict';
    return pidFile.exists ? 'stale_pid' : 'not_running';
  }

  if (!pidAlive) return 'stale_pid';

  if (owner && owner.pid !== pid) return 'orphan_process';

  if (!health) {
    return isRecentStart(pidFile.value.startedAt, now, startupGraceMs)
      ? 'starting'
      : 'unhealthy';
  }

  // readinessを取得できない場合も、livenessだけでhealthyへ昇格させない。
  // /readyのHTTP 404はcheckEmbeddingReadiness内で旧サーバのhealth結果に変換される。
  const readinessFailed = readiness === null || !readiness.ready;
  const healthFailed = health.ready === false || health.status === 'degraded';
  const probeFailed = probe !== null && !probe.success;
  return readinessFailed || healthFailed || probeFailed || metadataMatches === false ? 'degraded' : 'healthy';
}

/**
 * PID・ポート・HTTP liveness/readiness・推論probeを一度に評価する。
 */
export async function evaluateEmbeddingStatus(
  options: EvaluateEmbeddingStatusOptions,
): Promise<EmbeddingStatusSnapshot> {
  const preferredHost = options.host;
  const timeoutMs = options.timeoutMs ?? 3000;
  const now = options.now ?? Date.now();
  const startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  const pid = options.pidFile.value?.pid;
  const pidAlive = pid !== undefined && isProcessAlive(pid);
  const portAvailable = await isPortAvailable(options.port);
  const portListening = !portAvailable;
  const owner = portListening ? getListeningProcess(options.port) : null;
  const healthLocation = await findEmbeddingHealth(options.port, timeoutMs, preferredHost);
  const health = healthLocation?.health ?? null;
  const readinessLocation = healthLocation
    ? null
    : await findEmbeddingReadiness(options.port, timeoutMs, preferredHost);
  const readiness = healthLocation
    ? await checkEmbeddingReadiness(healthLocation.host, options.port, timeoutMs)
    : readinessLocation?.readiness ?? null;
  const probeLocation = options.probe && (portListening || health !== null)
    ? healthLocation
      ? {
          host: healthLocation.host,
          probe: await probeEmbedding(healthLocation.host, options.port, timeoutMs, health?.vectorDimension),
        }
      : await findEmbeddingProbe(options.port, timeoutMs, health?.vectorDimension, preferredHost)
    : null;
  const embedProbe = probeLocation?.probe ?? null;
  const host = healthLocation?.host ?? readinessLocation?.host ?? probeLocation?.host ?? preferredHost ?? '127.0.0.1';
  const metadataMatches = options.pidFile.value && health
    ? (!options.pidFile.value.model ||
      options.pidFile.value.model === 'unknown' ||
      options.pidFile.value.model === health.model) &&
      (!options.pidFile.value.dimension || options.pidFile.value.dimension === health.vectorDimension)
    : null;

  const checks: EmbeddingCheckResult[] = [];
  if (!options.pidFile.exists) {
    checks.push(result('pid_file', 'skipped', 'PID file not found (external process may be running)'));
  } else if (!options.pidFile.value) {
    checks.push(result('pid_file', 'failed', options.pidFile.error ?? 'PID file is invalid'));
  } else {
    checks.push(result('pid_file', 'ok', `PID ${options.pidFile.value.pid}, port ${options.pidFile.value.port}`));
  }

  if (pid === undefined) {
    checks.push(result('pid_alive', 'skipped', 'PID is not available'));
  } else {
    checks.push(result(
      'pid_alive',
      pidAlive ? 'ok' : 'failed',
      pidAlive ? `PID ${pid} is alive` : `PID ${pid} is not running`,
    ));
  }

  checks.push(result(
    'port_listening',
    portListening ? 'ok' : 'failed',
    portListening ? `port ${options.port} is listening` : `port ${options.port} is free`,
  ));

  if (!portListening) {
    checks.push(result('port_owner', 'skipped', 'No listening process found'));
  } else if (!owner) {
    checks.push(result('port_owner', 'unknown', 'Listening process PID could not be determined on this OS'));
  } else if (pid === undefined) {
    checks.push(result('port_owner', 'unknown', `PID ${owner.pid} owns the port (no PID file)`));
  } else {
    checks.push(result(
      'port_owner',
      owner.pid === pid ? 'ok' : 'failed',
      owner.pid === pid
        ? `owner PID ${owner.pid} matches PID file`
        : `owner PID ${owner.pid} does not match PID file PID ${pid}`,
      owner.command ? { command: owner.command } : undefined,
    ));
  }

  checks.push(result(
    'health',
    health ? 'ok' : 'failed',
    health
      ? `liveness ${health.status} (${health.latencyMs ?? 0}ms)`
      : 'GET /health did not return a valid response',
  ));

  checks.push(result(
    'readiness',
    readiness?.ready ? 'ok' : 'failed',
    readiness
      ? readiness.ready
        ? `ready (${readiness.latencyMs}ms)`
        : `not ready (HTTP ${readiness.statusCode}${readiness.consecutiveFailures !== undefined ? `, ${readiness.consecutiveFailures} consecutive failures` : ''})`
      : 'GET /ready and /health readiness checks did not respond',
  ));

  if (!options.probe) {
    checks.push(result('embed_probe', 'skipped', 'Not requested (use --probe)'));
  } else if (!embedProbe) {
    checks.push(result('embed_probe', 'failed', 'Probe could not run because the server is not listening'));
  } else {
    checks.push(result(
      'embed_probe',
      embedProbe.success ? 'ok' : 'failed',
      embedProbe.success
        ? `${embedProbe.endpoint} returned a ${embedProbe.vectorDimension}d vector (${embedProbe.latencyMs}ms)`
        : (embedProbe.error ?? 'embedding probe failed'),
    ));
  }

  if (!options.pidFile.value) {
    checks.push(result('metadata_match', 'skipped', 'No PID metadata available'));
  } else if (!health) {
    checks.push(result('metadata_match', 'unknown', 'Cannot compare metadata while /health is unavailable'));
  } else {
    const modelMatches = !options.pidFile.value.model ||
      options.pidFile.value.model === 'unknown' ||
      options.pidFile.value.model === health.model;
    const dimensionMatches = !options.pidFile.value.dimension || options.pidFile.value.dimension === health.vectorDimension;
    checks.push(result(
      'metadata_match',
      modelMatches && dimensionMatches ? 'ok' : 'failed',
      modelMatches && dimensionMatches
        ? 'PID metadata matches /health'
        : 'PID metadata does not match /health',
      { modelMatches, dimensionMatches },
    ));
  }

  const overallState = determineState({
    pidFile: options.pidFile,
    pidAlive,
    portListening,
    owner,
    health,
    readiness,
    probe: embedProbe,
    metadataMatches,
    now,
    startupGraceMs,
  });

  return {
    overallState,
    host,
    port: options.port,
    pidFile: options.pidFile,
    pidAlive,
    portListening,
    portOwner: owner,
    health,
    readiness,
    embedProbe,
    checks,
    suggestions: suggestionsFor(overallState, options.port, owner, options.pidFile),
    startupGraceMs,
  };
}
