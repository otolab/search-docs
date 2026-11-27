import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  stopTrackedChildren,
  trackChild,
} from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const marker = 'ISSUE183_DIAGNOSTIC_PAUSED:';
const dimension = 256;
const model = 'issue183-http-shutdown-test';
const apiKey = 'issue183-http-test-key';
const { DEFAULT_CONFIG } = await import(
  pathToFileURL(path.join(repo, 'packages/types/dist/index.js')).href
);
const { DBEngine, MaintenanceLock } = await import(
  pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href
);

const root = await mkdtemp(path.join(tmpdir(), 'issue183-http-shutdown-'));
const children = new Set();
const projectRoot = path.join(root, 'project');
const serverCopy = path.join(root, 'server-copy');
let child;
let stopCli;
let serverClosed;
let stopCliClosed;
let diagnosticPid;
let shutdownResponse;
let heartbeatBeforeShutdown;
let heartbeatAfterShutdown;
let watcherLogBeforeShutdown = '';
let diagnosticProcessBeforeShutdown = '';
let diagnosticProcessAfterShutdown = '';
let diagnosticAliveImmediatelyAfterShutdown;
let diagnosticProcessImmediatelyAfterShutdown = '';
let diagnosticGroupExitAfterShutdownMs;
let stderr = '';
let stdout = '';
let embeddingListening = false;
const embedding = createServer((request, response) => {
  if (request.url === '/health' || request.url === '/ready') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      status: 'ok',
      ready: true,
      model,
      vectorDimension: dimension,
    }));
    return;
  }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url !== '/v1/embeddings'
      || request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end();
      return;
    }
    const vectors = body.input.map(() => [
      1,
      ...Array.from({ length: dimension - 1 }, () => 0),
    ]);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }));
  });
});

function withTimeout(promise, message, timeoutMs = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]);
}

function waitForDiagnosticPause() {
  return withTimeout(new Promise((resolve, reject) => {
    const inspect = () => {
      const match = stderr.match(new RegExp(`${marker}(\\d+)`));
      if (!match) return false;
      diagnosticPid = Number(match[1]);
      resolve();
      return true;
    };
    if (inspect()) return;
    const poll = setInterval(() => {
      if (inspect()) clearInterval(poll);
    }, 20);
    child.once('exit', (code, signal) => {
      clearInterval(poll);
      void readFile(path.join(projectRoot, '.search-docs/server.log'), 'utf8')
        .catch(() => '')
        .then(serverLog => reject(new Error(
          `HTTP server exited before diagnostic pause: ${code}/${signal}\n`
          + `stdout:\n${stdout.slice(-1500)}\nstderr:\n${stderr.slice(-1500)}\n`
          + `server log:\n${serverLog.slice(-3000)}`,
        )));
    });
  }), 'timed out waiting for the writer diagnostic pause');
}

async function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') {
      const result = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        throw new Error('Could not confirm process-group state with signal-0 or ps', {
          cause: result.error,
        });
      }
      return result.stdout.split('\n').some(line => {
        const [processId, groupId] = line.trim().split(/\s+/).map(Number);
        return Number.isInteger(processId) && groupId === pid;
      });
    }
    throw error;
  }
}

function processSnapshot(pid) {
  const result = spawnSync('ps', [
    '-o', 'pid=,ppid=,pgid=,stat=,command=',
    '-p', String(pid),
  ], { encoding: 'utf8' });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Could not inspect fixture process ${pid}`, { cause: result.error });
  }
  return result.stdout.trim();
}

async function stopDiagnosticGroup(pid, timeoutMs = 5000) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (await processGroupExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Could not confirm process group ${pid} stopped`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port');
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function readWriterHeartbeat() {
  const diagnostic = new DBEngine({
    dbPath: path.join(projectRoot, '.search-docs/index'),
    readOnly: true,
  });
  await diagnostic.connect({ skipInitModel: true });
  try {
    return await diagnostic.getWriterHeartbeat();
  } finally {
    await diagnostic.disconnect();
  }
}

try {
  await new Promise((resolve, reject) => {
    embedding.once('error', reject);
    embedding.listen(0, '127.0.0.1', () => {
      embeddingListening = true;
      resolve();
    });
  });
  const embeddingAddress = embedding.address();
  if (!embeddingAddress || typeof embeddingAddress === 'string') {
    throw new Error('Could not start the local embedding fixture');
  }
  const embeddingUrl = `http://127.0.0.1:${embeddingAddress.port}`;
  const provider = {
    provider: 'openai-compatible',
    baseUrl: `${embeddingUrl}/v1`,
    model,
    apiKey,
  };
  const port = await reservePort();
  await mkdir(path.join(projectRoot, '.search-docs'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'source.md'),
    '# Source\n\nThis fixture must not index while writer diagnosis is paused.',
  );
  const config = {
    ...DEFAULT_CONFIG,
    project: { ...DEFAULT_CONFIG.project, name: 'issue183-http-shutdown-test', root: projectRoot },
    files: {
      ...DEFAULT_CONFIG.files,
      sources: ['*.md'],
      exclude: [],
      respectGitignore: false,
    },
    storage: {
      ...DEFAULT_CONFIG.storage,
      indexPath: '.search-docs/index',
      documentsPath: '.search-docs/documents',
    },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      embeddingUrl,
      embedding: provider,
      vectorDimension: dimension,
    },
    server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port },
    worker: { ...DEFAULT_CONFIG.worker, enabled: false },
  };
  await writeFile(path.join(projectRoot, '.search-docs.json'), JSON.stringify(config, null, 2));

  await mkdir(serverCopy, { recursive: true });
  await cp(path.join(repo, 'packages/server/dist'), path.join(serverCopy, 'dist'), {
    recursive: true,
  });
  await cp(
    path.join(repo, 'packages/server/package.json'),
    path.join(serverCopy, 'package.json'),
  );
  await symlink(
    path.join(repo, 'packages/server/node_modules'),
    path.join(serverCopy, 'node_modules'),
    'dir',
  );
  const diagnosticPath = path.join(
    serverCopy,
    'dist/discovery/strict-diagnostic.js',
  );
  const originalDiagnostic = await readFile(diagnosticPath, 'utf8');
  const callCounterAnchor = 'export async function diagnoseStrictConfig(config, options = {}) {';
  const connectAnchor = 'await diagnostic.connect({ skipInitModel: true });';
  assert(originalDiagnostic.includes(callCounterAnchor), 'strict diagnostic entry anchor changed');
  assert(originalDiagnostic.includes(connectAnchor), 'diagnostic connection anchor changed');
  const instrumentedDiagnostic = originalDiagnostic
    .replace(
      'const REQUIRED_TABLES =',
      'let __issue183StrictCallCount = 0;\nlet __issue183CurrentStrictCall = 0;\nconst REQUIRED_TABLES =',
    )
    .replace(
      callCounterAnchor,
      `${callCounterAnchor}\n    __issue183CurrentStrictCall = ++__issue183StrictCallCount;`,
    )
    .replace(
      connectAnchor,
      `${connectAnchor}
    if (__issue183CurrentStrictCall === 2 && process.env.ISSUE183_PAUSE_WRITER_DIAGNOSTIC === '1') {
      const pid = diagnostic.worker?.pid;
      process.stderr.write('${marker}' + String(pid ?? 'none') + '\\n');
      await new Promise(resolve => process.once('SIGUSR1', resolve));
    }`,
    );
  assert.notEqual(instrumentedDiagnostic, originalDiagnostic, 'diagnostic instrumentation did not match');
  await writeFile(diagnosticPath, instrumentedDiagnostic);

  const serverEntryUrl = pathToFileURL(
    path.join(serverCopy, 'dist/bin/server.js'),
  ).href;
  child = trackChild(children, spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { main } from ${JSON.stringify(serverEntryUrl)}; await main();`,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VIRTUAL_ENV: path.join(repo, 'packages/db-engine/.venv'),
      UV_PROJECT_ENVIRONMENT: path.join(repo, 'packages/db-engine/.venv'),
      UV_NO_SYNC: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ISSUE183_PAUSE_WRITER_DIAGNOSTIC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  serverClosed = once(child, 'close');
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => {
    stderr += data.toString();
    const match = stderr.match(new RegExp(`${marker}(\\d+)`));
    if (match) diagnosticPid = Number(match[1]);
  });
  await waitForDiagnosticPause();
  assert(Number.isInteger(diagnosticPid) && diagnosticPid > 1,
    `missing diagnostic worker PID: ${diagnosticPid}`);

  heartbeatBeforeShutdown = await readWriterHeartbeat();
  watcherLogBeforeShutdown = await readFile(
    path.join(projectRoot, '.search-docs/server.log'),
    'utf8',
  );
  assert(heartbeatBeforeShutdown.exists, 'writer claim heartbeat was not present');
  assert.equal(heartbeatBeforeShutdown.heartbeat.pid, child.pid,
    'heartbeat PID did not identify the HTTP server process');
  assert.equal(heartbeatBeforeShutdown.heartbeat.state, 'claiming',
    'writer was not directly observed in claiming state');
  diagnosticProcessBeforeShutdown = processSnapshot(diagnosticPid);
  assert(diagnosticProcessBeforeShutdown.includes(String(diagnosticPid)),
    'paused diagnostic worker PID was not present before shutdown');
  assert.match(watcherLogBeforeShutdown, /Claim won, transitioning to watching/,
    'server log did not confirm the writer claim readback');
  assert(!watcherLogBeforeShutdown.includes('→ WATCHING'),
    'server entered WATCHING before the diagnostic pause');

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await withTimeout((async () => {
    for (;;) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return response;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })(), 'HTTP server did not become healthy');
  assert.equal(health.status, 200);

  const stopModule = pathToFileURL(
    path.join(repo, 'packages/cli/dist/commands/server/stop.js'),
  ).href;
  const shutdownObservationPath = path.join(root, 'shutdown-response.json');
  const stopScript = `import { writeFile } from 'node:fs/promises';
import { stopServer } from ${JSON.stringify(stopModule)};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (String(args[0]).endsWith('/shutdown')) {
    await writeFile(${JSON.stringify(shutdownObservationPath)}, JSON.stringify({
      url: String(args[0]),
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      body: await response.clone().text(),
    }));
  }
  return response;
};
await stopServer({ cwd: process.argv[1] });
console.log('ISSUE183_CLI_STOP_RETURNED_SUCCESS');`;
  stopCli = trackChild(children, spawn(process.execPath, [
    '--input-type=module',
    '-e',
    stopScript,
    projectRoot,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VIRTUAL_ENV: path.join(repo, 'packages/db-engine/.venv'),
      UV_PROJECT_ENVIRONMENT: path.join(repo, 'packages/db-engine/.venv'),
      UV_NO_SYNC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  stopCliClosed = once(stopCli, 'close');
  let stopStdout = '';
  let stopStderr = '';
  stopCli.stdout.on('data', data => { stopStdout += data.toString(); });
  stopCli.stderr.on('data', data => { stopStderr += data.toString(); });
  const [stopCode, stopSignal] = await withTimeout(
    stopCliClosed,
    'CLI server stop did not finish',
  );
  assert.equal(stopCode, 0, `CLI server stop failed (${stopCode}/${stopSignal}): ${stopStderr}`);
  assert.match(stopStdout, /✓ Server stopped successfully/);
  shutdownResponse = JSON.parse(await readFile(shutdownObservationPath, 'utf8'));
  assert.equal(shutdownResponse.status, 200);
  assert.equal(shutdownResponse.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(shutdownResponse.body), { status: 'shutting down' });

  const [serverCode, serverSignal] = await withTimeout(
    serverClosed,
    'HTTP server did not exit after shutdown request',
  );
  diagnosticAliveImmediatelyAfterShutdown = await processGroupExists(diagnosticPid);
  diagnosticProcessImmediatelyAfterShutdown = processSnapshot(diagnosticPid);
  const diagnosticGroupProbeStartedAt = Date.now();
  while (await processGroupExists(diagnosticPid)
    && Date.now() - diagnosticGroupProbeStartedAt < 5000) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  diagnosticGroupExitAfterShutdownMs = await processGroupExists(diagnosticPid)
    ? null
    : Date.now() - diagnosticGroupProbeStartedAt;
  heartbeatAfterShutdown = await readWriterHeartbeat();
  const diagnosticAliveAfterShutdown = await processGroupExists(diagnosticPid);
  diagnosticProcessAfterShutdown = processSnapshot(diagnosticPid);
  const managementPath = path.join(
    projectRoot,
    '.search-docs/.search-docs-maintenance',
  );
  const usersAfterShutdown = await readdir(path.join(managementPath, 'users'));
  let exclusiveFailure = '';
  try {
    const lease = await new MaintenanceLock(managementPath).acquireExclusive();
    await lease.release();
  } catch (error) {
    exclusiveFailure = error.message;
  }
  const pidFileRemovedByCli = await stat(
    path.join(projectRoot, '.search-docs/server.pid'),
  ).then(() => false, error => error.code === 'ENOENT');

  assert.equal(serverCode, 0, `HTTP server exit was not successful: ${serverCode}/${serverSignal}`);
  assert.equal(serverSignal, null);
  assert(heartbeatAfterShutdown.exists, 'writer claim heartbeat disappeared after HTTP shutdown');
  assert.equal(heartbeatAfterShutdown.heartbeat.writerId,
    heartbeatBeforeShutdown.heartbeat.writerId);
  assert.equal(heartbeatAfterShutdown.heartbeat.pid, child.pid);
  assert.equal(heartbeatAfterShutdown.heartbeat.state, 'claiming');
  assert(!watcherLogBeforeShutdown.includes('→ WATCHING'));
  assert(usersAfterShutdown.length > 0, 'shared registration was unexpectedly released');
  assert.match(exclusiveFailure, /使用中/);
  assert(pidFileRemovedByCli, 'CLI did not remove the PID file after health disappeared');

  const result = {
    testEnvironment: 'real HTTP server, DBEngine, maintenance registration, CLI stop; disposable project and fake embedding endpoint',
    injectedCondition: 'writer-before-start strict diagnostic worker is paused; HTTP route itself is unchanged',
    httpShutdownResponse: shutdownResponse,
    serverExit: [serverCode, serverSignal],
    cliReportedSuccess: stopStdout.includes('✓ Server stopped successfully'),
    cliRemovedPidFile: pidFileRemovedByCli,
    diagnosticWorkerGroupAliveImmediatelyAfterServerExit: diagnosticAliveImmediatelyAfterShutdown,
    diagnosticWorkerGroupExitAfterShutdownMs: diagnosticGroupExitAfterShutdownMs,
    diagnosticWorkerGroupAliveAfterObservationDelay: diagnosticAliveAfterShutdown,
    diagnosticWorkerProcessImmediatelyAfterShutdown: diagnosticProcessImmediatelyAfterShutdown || null,
    diagnosticWorkerProcessBeforeShutdown: diagnosticProcessBeforeShutdown,
    diagnosticWorkerProcessAfterShutdown: diagnosticProcessAfterShutdown || null,
    sharedRegistrationsRemaining: usersAfterShutdown.length,
    exclusiveMaintenanceAttempt: exclusiveFailure,
    writerClaimBeforeShutdown: heartbeatBeforeShutdown.heartbeat,
    writerClaimAfterShutdown: heartbeatAfterShutdown.heartbeat,
    writerClaimReadbackObservedInServerLog: watcherLogBeforeShutdown.includes(
      'Claim won, transitioning to watching',
    ),
    watchingTransitionObservedBeforeShutdown: watcherLogBeforeShutdown.includes('→ WATCHING'),
    serverStdoutTail: stdout.slice(-1000),
    serverStderrTail: stderr.slice(-1200),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  let cleanupFailure;
  try { await stopTrackedChildren(children, root); }
  catch (error) { cleanupFailure = error; }
  try {
    if (diagnosticPid && await processGroupExists(diagnosticPid)) {
      await stopDiagnosticGroup(diagnosticPid);
    }
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (embeddingListening) {
    await new Promise(resolve => embedding.close(resolve));
  }
  if (cleanupFailure) {
    throw new Error(`Harness cleanup failed; preserving temporary data at ${root}`, {
      cause: cleanupFailure,
    });
  }
  await rm(root, { recursive: true, force: true });
}

if (diagnosticPid) {
  assert.equal(await processGroupExists(diagnosticPid), false,
    'cleanup did not confirm termination of the diagnostic process group');
}
await assert.rejects(stat(root), { code: 'ENOENT' });
