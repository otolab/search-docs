import { ConfigLoader } from '@search-docs/config';
import { startExternalEmbedding } from '@search-docs/server';
/**
 * embedding status コマンド
 */

import {
  DEFAULT_EMBEDDING_PORT,
  embeddingPidPathForPort,
  formatEmbeddingUrl,
  readEmbeddingPidFileForPort,
  readUniqueEmbeddingPidFile,
  removeEmbeddingPidFile,
} from '../../utils/embedding.js';
import {
  evaluateEmbeddingStatus,
  type EmbeddingCheckResult,
  type EmbeddingStatusSnapshot,
} from '../../utils/embedding-state.js';

export interface EmbeddingStatusOptions {
  port?: string | number;
  verbose?: boolean;
  repair?: boolean;
  probe?: boolean;
  timeout?: string | number;
}

export interface EmbeddingStatusResult {
  snapshot: EmbeddingStatusSnapshot;
  repaired: boolean;
}

function parsePort(value: string | number | undefined): number {
  const port = value === undefined ? DEFAULT_EMBEDDING_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

function parseTimeout(value: string | number | undefined): number {
  const timeout = value === undefined ? 3000 : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error(`Invalid timeout: ${String(value)}`);
  }
  return timeout;
}

function printCheck(check: EmbeddingCheckResult): void {
  const command = check.details?.command;
  const suffix = typeof command === 'string' ? ` (${command})` : '';
  console.log(`  ${check.check}: ${check.status}${suffix} — ${check.message}`);
}

function printProbe(snapshot: EmbeddingStatusSnapshot): void {
  const lastProbe = snapshot.health?.lastProbe;
  if (!lastProbe) {
    console.log('  Self probe: not reported by this server');
    return;
  }
  const error = lastProbe.error ? `, ${lastProbe.error}` : '';
  console.log(
    `  Self probe: ${lastProbe.success ? 'success' : 'failed'} ` +
    `(${lastProbe.latencyMs}ms at ${lastProbe.at}${error})`,
  );
  if (snapshot.health?.consecutiveFailures !== undefined) {
    console.log(`  Consecutive failures: ${snapshot.health.consecutiveFailures}`);
  }
}

function printStatus(snapshot: EmbeddingStatusSnapshot, options: EmbeddingStatusOptions, repaired: boolean): void {
  console.log(`Embedding server: ${snapshot.overallState}`);
  console.log(`  Port: ${snapshot.port}`);
  console.log(`  URL: ${formatEmbeddingUrl(snapshot.host, snapshot.port)}`);

  if (snapshot.health) {
    console.log(`  Model: ${snapshot.health.model}`);
    console.log(`  Dimension: ${snapshot.health.vectorDimension}`);
    console.log(`  Liveness: ${snapshot.health.status} (${snapshot.health.latencyMs ?? 0}ms)`);
    if (snapshot.health.runtime) console.log(`  Runtime: ${snapshot.health.runtime}`);
    if (snapshot.health.uptimeSeconds !== undefined) {
      console.log(`  Uptime: ${snapshot.health.uptimeSeconds}s`);
    }
    console.log(`  Readiness: ${snapshot.readiness?.ready ? 'ready' : 'not ready'}`);
    printProbe(snapshot);
  }

  if (snapshot.pidFile.value) {
    console.log(`  PID: ${snapshot.pidFile.value.pid}${snapshot.pidAlive ? '' : ' (not running)'}`);
    console.log(`  PID file port: ${snapshot.pidFile.value.port}`);
    if (snapshot.pidFile.value.startedAt) {
      console.log(`  Started: ${new Date(snapshot.pidFile.value.startedAt).toLocaleString()}`);
    }
    if (!snapshot.pidFile.value.launchId) {
      console.log(
        `  Ownership: unverified${snapshot.pidFile.legacy
          ? ' legacy PID record'
          : ' (launch identity missing or invalid)'}`,
      );
    }
    if (snapshot.pidFile.value.logPath) console.log(`  Log: ${snapshot.pidFile.value.logPath}`);
  } else if (!snapshot.pidFile.exists) {
    console.log('  PID: not recorded (external server may be running)');
  } else {
    console.log(`  PID: unavailable (${snapshot.pidFile.error ?? 'invalid PID file'})`);
  }

  if (options.verbose || options.probe) {
    console.log('\nChecks:');
    for (const check of snapshot.checks) printCheck(check);
  }

  if (repaired) {
    console.log('\nRepair: removed stale PID file.');
  }

  console.log('\nSuggestion:');
  if (snapshot.suggestions.length === 0) {
    console.log('  - none');
  } else {
    for (const suggestion of snapshot.suggestions) console.log(`  - ${suggestion}`);
  }
}

export async function showEmbeddingStatus(
  options: EmbeddingStatusOptions = {},
): Promise<EmbeddingStatusResult> {
  const explicitPort = options.port !== undefined;
  const requestedPort = explicitPort ? parsePort(options.port) : undefined;
  const selection = explicitPort
    ? { state: await readEmbeddingPidFileForPort(requestedPort!), port: requestedPort, ambiguousPorts: [] }
    : await readUniqueEmbeddingPidFile();
  if (selection.ambiguousPorts.length > 0) {
    const ports = selection.ambiguousPorts.filter((value) => value > 0);
    throw new Error(
      `Multiple or invalid embedding PID files make the target ambiguous` +
      `${ports.length ? ` (ports: ${ports.join(', ')})` : ''}. Specify --port <port>.`,
    );
  }
  let pidFile = selection.state;
  const port = parsePort(requestedPort ?? selection.port ?? pidFile.value?.port ?? DEFAULT_EMBEDDING_PORT);
  const timeoutMs = parseTimeout(options.timeout);
  let snapshot = await evaluateEmbeddingStatus({
    port,
    pidFile,
    probe: options.probe,
    timeoutMs,
  });
  let repaired = false;

  if (options.repair && snapshot.overallState === 'stale_pid' && pidFile.exists) {
    await removeEmbeddingPidFile(pidFile.path ?? embeddingPidPathForPort(port));
    repaired = true;
    pidFile = { exists: false, value: null, path: embeddingPidPathForPort(port), legacy: false };
    snapshot = await evaluateEmbeddingStatus({
      port,
      pidFile,
      probe: options.probe,
      timeoutMs,
    });
  }

  printStatus(snapshot, options, repaired);

  // JSON/終了コードの体系化はPhase 3だが、既存のstatusの挙動を維持する。
  process.exitCode = snapshot.overallState === 'healthy' || snapshot.overallState === 'orphan_process' ? 0 : 1;
  return { snapshot, repaired };
}

export async function executeEmbeddingStatus(options: EmbeddingStatusOptions): Promise<void> {
  try {
    const { config } = await ConfigLoader.resolve();
    const embedding = config.indexing.embedding;
    if (embedding && embedding.provider !== 'builtin') {
      await startExternalEmbedding(embedding, config.indexing.vectorDimension, parseTimeout(options.timeout));
      console.log(`Embedding provider ${embedding.provider}: healthy (dimension ${config.indexing.vectorDimension})`);
      process.exitCode = 0;
      return;
    }
    await showEmbeddingStatus(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exitCode = 1;
  }
}
