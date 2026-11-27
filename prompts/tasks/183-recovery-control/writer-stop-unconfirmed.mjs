import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopProcessGroup, stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const marker = 'ISSUE183_DIAGNOSTIC_PAUSED:';
const dimension = 256;
const model = 'issue183-shutdown-test';
const apiKey = 'issue183-test-key';
const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(repo, 'packages/types/dist/index.js')).href);
const { MaintenanceLock } = await import(pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href);

const root = await mkdtemp(path.join(tmpdir(), 'issue183-stop-unconfirmed-'));
const children = new Set();
const projectRoot = path.join(root, 'project');
const serverCopy = path.join(root, 'server-copy');
const serverDist = path.join(serverCopy, 'dist');
let child;
let diagnosticPid;
let stderr = '';
let stdout = '';
let log = '';
let result;
let embeddingListening = false;
const embedding = createServer((request, response) => {
  if (request.url === '/health' || request.url === '/ready') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      status: 'ok', ready: true, model, vectorDimension: dimension,
    }));
    return;
  }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url !== '/v1/embeddings' || request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end();
      return;
    }
    const vectors = body.input.map(() => [1, ...Array.from({ length: dimension - 1 }, () => 0)]);
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
      if (match) {
        diagnosticPid = Number(match[1]);
        resolve();
        return true;
      }
      return false;
    };
    if (inspect()) return;
    const poll = setInterval(() => {
      if (inspect()) clearInterval(poll);
    }, 20);
    child.once('exit', (code, signal) => {
      clearInterval(poll);
      reject(new Error(`MCP exited before writer diagnostic pause: ${code}/${signal}\n${stderr.slice(-2500)}`));
    });
  }), 'timed out waiting for writer diagnostic pause');
}

function waitForInitialize() {
  return withTimeout(new Promise((resolve, reject) => {
    let pending = '';
    child.stdout.on('data', data => {
      stdout += data.toString();
      pending += data.toString();
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) resolve(message.result);
        } catch {}
      }
    });
    child.once('exit', (code, signal) => reject(new Error(`MCP exited before initialize: ${code}/${signal}\n${stderr.slice(-2500)}`)));
  }), 'MCP initialize timed out');
}

async function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function readSectionsCount() {
  const python = path.join(repo, 'packages/db-engine/.venv/bin/python');
  const database = path.join(projectRoot, '.search-docs/index');
  const code = "import sys,lancedb; db=lancedb.connect(sys.argv[1]); print(db.open_table('sections').count_rows())";
  const child = trackChild(children, spawn(python, ['-c', code, database], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let output = '';
  let errors = '';
  let timedOut = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        reject(new Error(timedOut
          ? 'Timed out reading the disposable fixture database'
          : `Could not read fixture sections (${code}/${signal}): ${errors}`));
      } else {
        resolve(Number(output.trim()));
      }
    });
  });
}

try {
  await new Promise((resolve, reject) => {
    embedding.once('error', reject);
    embedding.listen(0, '127.0.0.1', () => {
      embeddingListening = true;
      resolve();
    });
  });
  const address = embedding.address();
  if (!address || typeof address === 'string') throw new Error('Could not start local embedding fixture');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const provider = { provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, model, apiKey };
  await mkdir(path.join(projectRoot, '.search-docs'), { recursive: true });
  await writeFile(path.join(projectRoot, 'source.md'), '# Source\n\nMust not be indexed before the writer gate passes.');
  const config = {
    ...DEFAULT_CONFIG,
    project: { ...DEFAULT_CONFIG.project, name: 'issue183-shutdown-test', root: projectRoot },
    files: { ...DEFAULT_CONFIG.files, sources: ['*.md'], exclude: [], respectGitignore: false },
    storage: { ...DEFAULT_CONFIG.storage, indexPath: '.search-docs/index', documentsPath: '.search-docs/documents' },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      embeddingUrl: baseUrl,
      embedding: provider,
      vectorDimension: dimension,
    },
    worker: { ...DEFAULT_CONFIG.worker, enabled: false },
  };
  await writeFile(path.join(projectRoot, '.search-docs.json'), JSON.stringify(config, null, 2));

  await mkdir(serverCopy, { recursive: true });
  await cp(path.join(repo, 'packages/server/dist'), serverDist, { recursive: true });
  await symlink(path.join(repo, 'packages/server/node_modules'), path.join(serverCopy, 'node_modules'), 'dir');
  const diagnosticPath = path.join(serverDist, 'discovery/strict-diagnostic.js');
  const originalDiagnostic = await readFile(diagnosticPath, 'utf8');
  const callCounterAnchor = 'export async function diagnoseStrictConfig(config, options = {}) {';
  const connectAnchor = 'await diagnostic.connect({ skipInitModel: true });';
  assert(originalDiagnostic.includes(callCounterAnchor), 'strict diagnostic entry anchor changed');
  assert(originalDiagnostic.includes(connectAnchor), 'strict diagnostic connect anchor changed');
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
      process.env.ISSUE183_FAIL_PROCESS_GROUP = String(pid ?? '');
    }`,
    );
  assert.notEqual(instrumentedDiagnostic, originalDiagnostic, 'strict diagnostic instrumentation did not match');
  await writeFile(diagnosticPath, instrumentedDiagnostic);

  const loaderPath = path.join(root, 'server-loader.mjs');
  await writeFile(loaderPath, `import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@search-docs/server') {
    return { url: pathToFileURL(path.join(process.env.ISSUE183_SERVER_COPY, 'dist/index.js')).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  const preloadPath = path.join(root, 'stop-fault-preload.mjs');
  await writeFile(preloadPath, `const originalKill = process.kill.bind(process);
process.kill = function(pid, signal) {
  const faultPid = Number(process.env.ISSUE183_FAIL_PROCESS_GROUP);
  if (faultPid > 1 && pid === -faultPid && signal === 'SIGTERM') {
    const error = new Error('injected EPERM while sending SIGTERM to the diagnostic process group');
    error.code = 'EPERM';
    throw error;
  }
  return originalKill(pid, signal);
};
`);

  child = trackChild(children, spawn(process.execPath, [path.join(repo, 'packages/mcp-server/dist/server.js'), '--project-dir', projectRoot], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VIRTUAL_ENV: path.join(repo, 'packages/db-engine/.venv'),
      UV_PROJECT_ENVIRONMENT: path.join(repo, 'packages/db-engine/.venv'),
      UV_NO_SYNC: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ISSUE183_SERVER_COPY: serverCopy,
      ISSUE183_PAUSE_WRITER_DIAGNOSTIC: '1',
      NODE_OPTIONS: [
        `--experimental-loader=${pathToFileURL(loaderPath).href}`,
        `--import=${pathToFileURL(preloadPath).href}`,
      ].join(' '),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
  child.stderr.on('data', data => {
    stderr += data.toString();
    const match = stderr.match(new RegExp(`${marker}(\\d+)`));
    if (match) diagnosticPid = Number(match[1]);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'issue183-stop-test', version: '1' } },
  })}\n`);
  await Promise.all([waitForInitialize(), waitForDiagnosticPause()]);
  assert(Number.isInteger(diagnosticPid) && diagnosticPid > 1, `missing diagnostic child PID: ${diagnosticPid}`);

  const logPath = path.join(projectRoot, '.search-docs/server.log');
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 500));
  const parentWaitedForDiagnostic = child.exitCode === null && child.signalCode === null;
  const diagnosticAliveBeforeResume = await processGroupExists(diagnosticPid);
  const managementPath = path.join(projectRoot, '.search-docs/.search-docs-maintenance');
  const usersPath = path.join(managementPath, 'users');
  const usersDuringShutdown = await readdir(usersPath);
  assert(parentWaitedForDiagnostic, 'MCP exited before the paused diagnostic was released');
  assert(diagnosticAliveBeforeResume, 'diagnostic process group was not alive during the injected stop failure');
  assert(usersDuringShutdown.length > 0, 'shared registration was removed before stop outcome was known');

  child.kill('SIGUSR1');
  let exit = null;
  try {
    exit = await withTimeout(once(child, 'exit'), 'MCP did not finish shutdown after releasing the diagnostic');
  } catch {
    // Capture the retention evidence before forcing cleanup of the intentionally leaked child.
  }
  const usersAfterShutdown = await readdir(usersPath);
  const diagnosticAliveAfterShutdown = await processGroupExists(diagnosticPid);
  let exclusiveFailure = '';
  try {
    const lock = new MaintenanceLock(managementPath);
    const lease = await lock.acquireExclusive();
    await lease.release();
  } catch (error) {
    exclusiveFailure = error.message;
  }
  assert(usersAfterShutdown.length > 0, 'shared registration was released despite unconfirmed diagnostic stop');
  assert(diagnosticAliveAfterShutdown, 'diagnostic process group was stopped despite the injected EPERM');
  assert.match(exclusiveFailure, /使用中/);
  log = await readFile(logPath, 'utf8').catch(() => '');
  assert(!log.includes('[WatcherProcess] → WATCHING'), 'writer entered WATCHING after its pre-writer diagnostic failed');
  assert.equal(await readSectionsCount(), 0, 'source was indexed before the writer diagnostic passed');

  result = {
    injectedFault: 'process.kill(-diagnosticPid, SIGTERM) throws EPERM inside the MCP process only; signal-0 existence check succeeds',
    processGroupAliveBeforeResume: diagnosticAliveBeforeResume,
    processGroupAliveAfterShutdown: diagnosticAliveAfterShutdown,
    MCPShutdownExit: exit ? [exit[0], exit[1]] : 'did not settle within timeout; observed state before cleanup',
    shutdownFailureReported: Boolean(exit && typeof exit[0] === 'number' && exit[0] !== 0),
    selectedShutdownDirectionObserved: Boolean(exit && typeof exit[0] === 'number' && exit[0] !== 0 && usersAfterShutdown.length > 0),
    usersRetainedDuringShutdown: usersDuringShutdown.length,
    usersRetainedAfterUnconfirmedStop: usersAfterShutdown.length,
    exclusiveBlocked: exclusiveFailure,
    writerEnteredWatching: false,
    indexedSections: 0,
    stderrTail: stderr.slice(-1600),
  };
} finally {
  let cleanupFailure;
  try { await stopTrackedChildren(children, root); }
  catch (error) { cleanupFailure = error; }
  try { if (diagnosticPid) await stopProcessGroup(diagnosticPid); }
  catch (error) { cleanupFailure ??= error; }
  if (embeddingListening) await new Promise(resolve => embedding.close(() => resolve()));
  if (cleanupFailure) {
    throw new Error(`Harness cleanup failed; preserving temporary data at ${root}`, { cause: cleanupFailure });
  }
  await rm(root, { recursive: true, force: true });
}

if (diagnosticPid) assert.equal(await processGroupExists(diagnosticPid), false,
  'cleanup did not confirm termination of the diagnostic process group');
await assert.rejects(stat(root), { code: 'ENOENT' });
console.log(JSON.stringify({
  ...result,
  cleanup: {
    diagnosticProcessGroupStopped: Boolean(diagnosticPid),
    temporaryRootRemovedAfterChildClose: true,
  },
}, null, 2));
