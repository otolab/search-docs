import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'issue183-stale-writer-'));
const projectRoot = path.join(root, 'project');
const indexPath = path.join(projectRoot, '.search-docs/index');
const children = new Set();
const dimension = 256;
const pythonEnvironment = path.join(repo, 'packages/db-engine/.venv');
process.env.VIRTUAL_ENV = pythonEnvironment;
process.env.UV_PROJECT_ENVIRONMENT = pythonEnvironment;
process.env.UV_NO_SYNC = '1';
process.env.PYTHONDONTWRITEBYTECODE = '1';

let endpoint;
let endpointListening = false;
let engine;
let verifier;
let watcher;
let oldWriter;
let oldWorkerPids = [];
let result;
let cleanupFailure;
let oldConstants;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(50);
  }
  throw new Error(message);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind fixture endpoint');
  return { port: address.port, url: `http://127.0.0.1:${address.port}` };
}

function send(child, id, command, args = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`old writer command timed out: ${command}`)), 20000);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = message => {
      if (message?.id !== id) return;
      if (message.error) finish(new Error(message.error));
      else finish(undefined, message.value);
    };
    const onExit = (code, signal) => finish(new Error(`old writer exited before response: ${code}/${signal}`));
    const onError = error => finish(error);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
    child.send({ id, command, args }, error => {
      if (error) finish(error);
    });
  });
}

function processInfo(pid) {
  const output = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' }).trim();
  const match = output.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  return match ? {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    processGroup: Number(match[3]),
    state: match[4],
    command: match[5],
  } : null;
}

try {
  const { DBEngine } = await import(pathToFileURL(
    path.join(repo, 'packages/db-engine/dist/index.js'),
  ).href);
  const { WatcherProcess } = await import(pathToFileURL(
    path.join(repo, 'packages/server/dist/index.js'),
  ).href);
  const { DEFAULT_CONFIG } = await import(pathToFileURL(
    path.join(repo, 'packages/types/dist/index.js'),
  ).href);

  await mkdir(path.join(projectRoot, '.search-docs/documents'), { recursive: true });
  await writeFile(path.join(projectRoot, 'fixture.md'), '# Disposable heartbeat fixture\n');
  endpoint = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'ok', ready: true, model: 'issue183-heartbeat-model', vectorDimension: dimension }));
  });
  const fixtureEndpoint = await listen(endpoint);
  endpointListening = true;

  engine = new DBEngine({
    dbPath: indexPath,
    embeddingUrl: fixtureEndpoint.url,
    embeddingDimension: dimension,
    pythonMaxMemoryMB: undefined,
  });
  await engine.connect();

  const childModule = path.join(root, 'old-writer-child.mjs');
  const dbEngineUrl = pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href;
  await writeFile(childModule, `
import { DBEngine } from ${JSON.stringify(dbEngineUrl)};
let engine;
process.on('message', async ({ id, command, args }) => {
  try {
    let value;
    if (command === 'connect') {
      engine = new DBEngine({ dbPath: args.dbPath });
      await engine.connect({ skipInitModel: true });
      value = { workerPids: [...engine.workerGroups].map(worker => worker.pid) };
    } else if (command === 'claim') {
      await engine.claimWriter({ writerId: args.writerId, host: 'fixture-old-writer', pid: process.pid });
      await engine.updateHeartbeat({
        writerId: args.writerId, host: 'fixture-old-writer', pid: process.pid, state: 'watching',
      });
      value = await engine.getWriterHeartbeat();
    } else if (command === 'write-after-takeover') {
      value = await engine.createIndexRequest({
        documentPath: args.documentPath, documentHash: args.documentHash,
      });
    } else if (command === 'stop') {
      await engine?.disconnect();
      process.send?.({ id, value: { disconnected: true } }, () => process.exit(0));
      setTimeout(() => process.exit(1), 1000).unref();
      return;
    } else {
      throw new Error('unknown command: ' + command);
    }
    process.send?.({ id, value });
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`);

  oldWriter = trackChild(children, fork(childModule, [], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  let requestId = 0;
  const oldWriterRequest = (command, args = {}) => send(oldWriter, ++requestId, command, args);
  const connected = await oldWriterRequest('connect', { dbPath: indexPath });
  oldWorkerPids = connected.workerPids;
  await oldWriterRequest('claim', { writerId: 'issue183-old-writer' });

  const timeoutMs = 3000;
  const constants = WatcherProcess;
  oldConstants = {
    MASTER_TIMEOUT_MS: constants.MASTER_TIMEOUT_MS,
    MASTER_CHECK_INTERVAL_MS: constants.MASTER_CHECK_INTERVAL_MS,
    CLAIM_JITTER_MAX_MS: constants.CLAIM_JITTER_MAX_MS,
    CLAIM_READBACK_DELAY_MS: constants.CLAIM_READBACK_DELAY_MS,
  };
  constants.MASTER_TIMEOUT_MS = timeoutMs;
  constants.MASTER_CHECK_INTERVAL_MS = 100;
  constants.CLAIM_JITTER_MAX_MS = 0;
  constants.CLAIM_READBACK_DELAY_MS = 0;

  const config = structuredClone(DEFAULT_CONFIG);
  config.project = { ...config.project, name: 'issue183-stale-writer', root: projectRoot };
  config.storage = {
    ...config.storage,
    indexPath: '.search-docs/index',
    documentsPath: '.search-docs/documents',
  };
  config.worker = { ...config.worker, enabled: false };
  config.watcher = { ...config.watcher, enabled: false };
  watcher = new WatcherProcess(config, {}, engine);
  const internal = watcher;
  internal.startupSyncWorker = { startSync: () => {}, waitForSync: async () => {} };
  await internal.checkAndClaimMaster();
  assert.equal(watcher.getStatus().writerState, 'sleeping');

  let heartbeatAgeBeforeTakeover;
  await waitUntil(async () => {
    const current = await engine.getWriterHeartbeat();
    heartbeatAgeBeforeTakeover = current.heartbeat?.ageSeconds;
    if (heartbeatAgeBeforeTakeover > timeoutMs / 1000) {
      await internal.checkAndClaimMaster();
    }
    return watcher.getStatus().writerState === 'watching';
  }, 'new Watcher did not take over after the old heartbeat lease expired', timeoutMs + 15000);

  const ownerBeforeWrite = (await engine.getWriterHeartbeat()).heartbeat;
  const staleWrite = await oldWriterRequest('write-after-takeover', {
    documentPath: 'stale-after-takeover.md',
    documentHash: 'fixture-write-after-lease-expiry',
  });
  verifier = new DBEngine({ dbPath: indexPath, readOnly: true });
  await verifier.connect({ skipInitModel: true });
  const persistedRequests = await verifier.findIndexRequests({ documentPath: 'stale-after-takeover.md' });
  const ownerAfterWrite = (await engine.getWriterHeartbeat()).heartbeat;
  result = {
    testEnvironment: 'disposable LanceDB, two real Node processes, loopback fake embedding endpoint',
    oldProcess: {
      kind: 'connected DBEngine worker whose previous heartbeat identity expired; it has no Watcher loop',
      processId: oldWriter.pid,
      workerPids: oldWorkerPids,
      aliveAfterTakeoverWrite: oldWriter.exitCode === null && oldWriter.signalCode === null,
    },
    leaseTimeoutMs: timeoutMs,
    heartbeatAgeSecondsBeforeTakeover: heartbeatAgeBeforeTakeover,
    newWatcherState: watcher.getStatus().writerState,
    newOwnerBeforeOldWrite: ownerBeforeWrite?.writerId,
    staleDbEngineWriteAccepted: true,
    staleWriteResult: { id: staleWrite.id, status: staleWrite.status },
    staleWritePersisted: persistedRequests.some(request => request.documentHash === 'fixture-write-after-lease-expiry'),
    persistedRequest: persistedRequests.find(request => request.documentHash === 'fixture-write-after-lease-expiry'),
    newOwnerAfterOldWrite: ownerAfterWrite?.writerId,
    connectedDatabaseWorkers: [
      ...oldWorkerPids.map(processInfo),
      ...[...engine.workerGroups].map(worker => processInfo(worker.pid)),
    ],
    concurrentNativeWritesAttempted: false,
  };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.newOwnerBeforeOldWrite, watcher.getStatus().writerId);
  assert.equal(result.staleWritePersisted, true);
  assert.equal(result.newOwnerAfterOldWrite, result.newOwnerBeforeOldWrite);
} finally {
  if (watcher) {
    try { await watcher.stop(); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (engine) {
    try { await engine.disconnect(); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (verifier) {
    try { await verifier.disconnect(); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (oldWriter && oldWriter.exitCode === null && oldWriter.signalCode === null) {
    try {
      await send(oldWriter, 9999, 'stop');
      await waitUntil(() => oldWriter.exitCode !== null || oldWriter.signalCode !== null,
        'old writer did not exit after its acknowledged disconnect', 5000);
    }
    catch (error) { cleanupFailure ??= error; }
  }
  try { await stopTrackedChildren(children, root); }
  catch (error) { cleanupFailure ??= error; }
  if (endpointListening) {
    try { await new Promise((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (oldConstants) {
    const { WatcherProcess } = await import(pathToFileURL(
      path.join(repo, 'packages/server/dist/index.js'),
    ).href);
    Object.assign(WatcherProcess, oldConstants);
  }

  const lingeringDbProcesses = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes(`--db-path=${indexPath}`));
  if (lingeringDbProcesses.length > 0) cleanupFailure ??= new Error(`Fixture DB worker remains; preserving ${root}: ${lingeringDbProcesses.join('\n')}`);
  if (cleanupFailure) {
    throw new Error(`Fixture cleanup was not confirmed; preserving ${root}`, { cause: cleanupFailure });
  }
  await rm(root, { recursive: true, force: true });
}
