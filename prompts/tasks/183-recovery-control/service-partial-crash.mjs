import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'issue183-service-partial-crash-'));
const children = new Set();
const indexPath = path.join(root, 'project/.search-docs/index');
const projectRoot = path.dirname(path.dirname(indexPath));
const managementPath = path.join(projectRoot, '.search-docs/.search-docs-maintenance');
const childRegistry = path.join(root, 'service-child-groups.jsonl');
const runtimeEnv = {
  ...process.env,
  VIRTUAL_ENV: path.join(repo, 'packages/db-engine/.venv'),
  UV_PROJECT_ENVIRONMENT: path.join(repo, 'packages/db-engine/.venv'),
  UV_NO_SYNC: '1',
  UV_CACHE_DIR: path.join(root, 'uv-cache'),
  PYTHONDONTWRITEBYTECODE: '1',
};
const dimension = 256;
const model = 'issue183-service-partial-test';
const apiKey = 'issue183-service-partial-key';
const uvResult = spawnSync('which', ['uv'], { encoding: 'utf8' });
if (uvResult.status !== 0) throw new Error('uv was not found in PATH');
const realUv = uvResult.stdout.trim();
const { DEFAULT_CONFIG } = await import(
  pathToFileURL(path.join(repo, 'packages/types/dist/index.js')).href
);
const { strictMaintenanceLock } = await import(
  pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href
);

let embeddingListening = false;
const embeddingRequests = [];
const embedding = createServer((request, response) => {
  embeddingRequests.push(request.url);
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, message, timeoutMs = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function hashTree(directory) {
  const entries = [];
  async function visit(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push([key, 'directory']);
        await visit(file, key);
      } else if (entry.isSymbolicLink()) {
        entries.push([key, `symlink:${await readFile(file).catch(() => '')}`]);
      } else {
        entries.push([
          key,
          createHash('sha256').update(await readFile(file)).digest('hex'),
        ]);
      }
    }
  }
  try {
    await visit(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}

function processGroupSnapshot(pid) {
  const result = spawnSync('ps', [
    '-axo', 'pid=,pgid=,ppid=,command=',
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Could not inspect process groups with ps', { cause: result.error });
  }
  return result.stdout.split('\n').map(line => line.trim())
    .filter(Boolean)
    .filter(line => Number(line.split(/\s+/)[1]) === pid);
}

async function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return processGroupSnapshot(pid).length > 0;
    throw error;
  }
}

async function stopKnownWorkerGroup(pid) {
  const snapshot = processGroupSnapshot(pid);
  if (snapshot.length === 0) return false;
  const expectedPath = path.resolve(indexPath);
  assert(
    snapshot.every(line => line.includes(expectedPath) && line.includes('worker.py')),
    `refusing to signal process group ${pid} whose command does not identify the fixture worker: ${snapshot.join('\n')}`,
  );
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 5000;
  while (await processGroupExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Could not confirm fixture worker group ${pid} stopped`);
    }
    await delay(25);
  }
  return true;
}

async function waitForExit(child, label, timeoutMs = 30000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return withTimeout(once(child, 'exit'), `${label} did not exit`, timeoutMs);
}

async function readUsers() {
  try {
    return await readdir(path.join(managementPath, 'users'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readChildGroups() {
  const content = await readFile(childRegistry, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function serviceEnvironment(preloadPath, binDirectory) {
  return {
    ...runtimeEnv,
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
    SEARCH_DOCS_LOG_PATH: path.join(projectRoot, '.search-docs/service.log'),
    NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
    ISSUE183_CHILD_REGISTRY: childRegistry,
    ISSUE183_MCP_DEBUG_LOG: path.join(root, 'mcp-debug.log'),
    ISSUE183_MCP_DEBUG_AUDIT: path.join(root, 'mcp-debug-redirect.jsonl'),
    ISSUE183_FIXTURE_ROOT: root,
  };
}

async function runFailClosedService(label, command, args, env) {
  const before = await hashTree(indexPath);
  const usersBefore = await readUsers();
  const child = trackChild(children, spawn(command, args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await waitForExit(child, `${label} startup`);
  const serviceLog = await readFile(path.join(projectRoot, '.search-docs/service.log'), 'utf8')
    .catch(() => '');
  const debugLog = await readFile(path.join(root, 'mcp-debug.log'), 'utf8').catch(() => '');
  const output = `${stdout}\n${stderr}\n${serviceLog}\n${debugLog}`;
  assert.equal(code, 1, `${label} should reject the partial DB; output:\n${output.slice(-6000)}`);
  assert.match(output, /writer_heartbeat/);
  const after = await hashTree(indexPath);
  assert.deepEqual(after, before, `${label} diagnosis changed the partial DB`);
  const usersAfter = await readUsers();
  assert.deepEqual(usersAfter, usersBefore, `${label} did not release only its own shared registration`);
  const groups = await readChildGroups();
  const aliveGroups = [];
  for (const { pid, args: spawnedArgs } of groups) {
    if (spawnedArgs.some(value => value.includes(path.resolve(indexPath)))
      && await processGroupExists(pid)) {
      aliveGroups.push(pid);
    }
  }
  for (const pid of aliveGroups) await stopKnownWorkerGroup(pid);
  return {
    exit: [code, signal],
    reportedMissingRequiredTable: true,
    databaseTreeUnchanged: true,
    sharedUsersBefore: usersBefore.length,
    sharedUsersAfter: usersAfter.length,
    spawnedDbWorkerGroupsStillAliveAfterExit: aliveGroups.length,
    diagnosticOutputTail: output.slice(-1000),
  };
}

let result;
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
    throw new Error('Could not bind fake embedding server');
  }
  const embeddingUrl = `http://127.0.0.1:${embeddingAddress.port}`;
  const provider = {
    provider: 'openai-compatible',
    baseUrl: `${embeddingUrl}/v1`,
    model,
    apiKey,
  };
  const config = {
    ...DEFAULT_CONFIG,
    project: { ...DEFAULT_CONFIG.project, name: 'issue183-service-partial-test', root: projectRoot },
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
    worker: { ...DEFAULT_CONFIG.worker, enabled: false },
    watcher: { ...DEFAULT_CONFIG.watcher, enabled: false },
  };
  await mkdir(path.join(projectRoot, '.search-docs/documents'), { recursive: true });
  await writeFile(path.join(projectRoot, 'source.md'), '# Fixture\n\nDisposable crash fixture.');
  await writeFile(path.join(projectRoot, '.search-docs.json'), JSON.stringify(config, null, 2));
  await writeFile(childRegistry, '');

  const instrumentedPython = path.join(root, 'instrumented-python');
  await cp(path.join(repo, 'packages/db-engine/src/python'), instrumentedPython, { recursive: true });
  const workerPath = path.join(instrumentedPython, 'worker.py');
  const originalWorker = await readFile(workerPath, 'utf8');
  const sectionCreate = 'self.db.create_table(SECTIONS_TABLE, schema=get_sections_schema(self.vector_dimension))';
  const importAnchor = 'from pathlib import Path';
  assert(originalWorker.includes(sectionCreate), 'could not find sections create call in worker source');
  assert(originalWorker.includes(importAnchor), 'could not find worker import anchor');
  const instrumentedWorker = originalWorker
    .replace(importAnchor, `${importAnchor}

def _issue183_pause_after_sections():
    import os, sys, time
    if os.environ.get('ISSUE183_PAUSE_AFTER_SECTIONS') == '1':
        sys.stderr.write('ISSUE183_PAUSED_AFTER_SECTIONS\\n')
        sys.stderr.flush()
        while True:
            time.sleep(1)
`)
    .replace(
      sectionCreate,
      `${sectionCreate}
                    _issue183_pause_after_sections()`,
    );
  assert.notEqual(instrumentedWorker, originalWorker, 'worker barrier instrumentation did not apply');
  await writeFile(workerPath, instrumentedWorker);

  const binDirectory = path.join(root, 'bin');
  await mkdir(binDirectory);
  const uvWrapper = path.join(binDirectory, 'uv');
  await writeFile(uvWrapper, `#!/bin/bash
args=()
for arg in "$@"; do
  if [ "$arg" = "${path.join(repo, 'packages/db-engine/src/python/worker.py')}" ]; then
    args+=("${workerPath}")
  else
    args+=("$arg")
  fi
done
exec "${realUv}" "\${args[@]}"
`);
  await chmod(uvWrapper, 0o755);

  const preloadPath = path.join(root, 'service-preload.mjs');
  await writeFile(preloadPath, `
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const originalAppendFileSync = fs.appendFileSync.bind(fs);
fs.appendFileSync = function(file, data, ...args) {
  if (file === '/tmp/mcp-server-debug.log') {
    const destination = process.env.ISSUE183_MCP_DEBUG_LOG;
    const audit = process.env.ISSUE183_MCP_DEBUG_AUDIT;
    const fixture = process.env.ISSUE183_FIXTURE_ROOT;
    const inside = target => {
      const relative = path.relative(fixture, path.resolve(target));
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep)
        && !path.isAbsolute(relative);
    };
    if (!destination || !audit || !inside(destination) || !inside(audit)) {
      throw new Error('Refusing to redirect MCP debug output outside the fixture');
    }
    originalAppendFileSync(audit, JSON.stringify({ requestedPath: file, redirectedPath: destination }) + '\\n');
    return originalAppendFileSync(destination, data, ...args);
  }
  return originalAppendFileSync(file, data, ...args);
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, args = [], options = {}) {
  const child = originalSpawn.call(this, command, args, options);
  if (child.pid && process.env.ISSUE183_CHILD_REGISTRY
    && args.some(value => typeof value === 'string' && value.includes(process.env.ISSUE183_FIXTURE_ROOT))) {
    appendFileSync(process.env.ISSUE183_CHILD_REGISTRY, JSON.stringify({
      pid: child.pid, command, args,
    }) + '\\n');
  }
  return child;
};
const path = require('node:path');
syncBuiltinESMExports();
`);
  const env = await serviceEnvironment(preloadPath, binDirectory);
  const mcpEnv = {
    ...env,
    ISSUE183_PAUSE_AFTER_SECTIONS: '1',
  };
  const mcp = trackChild(children, spawn(process.execPath, [
    path.join(repo, 'packages/mcp-server/dist/server.js'),
    '--project-dir',
    projectRoot,
  ], { cwd: projectRoot, env: mcpEnv, stdio: ['ignore', 'pipe', 'pipe'] }));
  let startupStdout = '';
  let startupStderr = '';
  mcp.stdout.setEncoding('utf8');
  mcp.stderr.setEncoding('utf8');
  mcp.stdout.on('data', chunk => { startupStdout += chunk; });
  mcp.stderr.on('data', chunk => { startupStderr += chunk; });
  const serviceLogPath = path.join(projectRoot, '.search-docs/service.log');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      const serviceLog = await readFile(serviceLogPath, 'utf8').catch(() => '');
      reject(new Error(
        'MCP did not reach the SearchDocsWorker sections barrier\n'
        + `exit=${mcp.exitCode}/${mcp.signalCode}\nstdout:\n${startupStdout.slice(-3000)}\nstderr:\n${startupStderr.slice(-5000)}`
        + `\nservice log:\n${serviceLog.slice(-5000)}`
        + `\nembedding requests: ${JSON.stringify(embeddingRequests)}`,
      ));
    }, 30000);
    timer.unref();
    const check = async () => {
      const serviceLog = await readFile(serviceLogPath, 'utf8').catch(() => '');
      if (serviceLog.includes('ISSUE183_PAUSED_AFTER_SECTIONS')
        || startupStderr.includes('ISSUE183_PAUSED_AFTER_SECTIONS')) {
        clearTimeout(timer);
        return resolve();
      }
      if (mcp.exitCode !== null || mcp.signalCode !== null) {
        clearTimeout(timer);
        reject(new Error(
          `MCP exited before SearchDocsWorker reached barrier: ${mcp.exitCode}/${mcp.signalCode}\n`
          + `${startupStdout.slice(-1500)}\n${startupStderr.slice(-2500)}`,
        ));
        return;
      }
      setTimeout(() => { void check(); }, 20).unref();
    };
    void check();
  });
  const tablesAtBarrier = ['embedding_identity', 'sections'];
  const databaseAtBarrier = await hashTree(indexPath);
  const firstWorkerGroup = (await readChildGroups()).find(item =>
    item.args.some(value => typeof value === 'string' && value.includes(path.resolve(indexPath)))
    && item.args.some(value => typeof value === 'string' && value.includes('worker.py'))
    && !item.args.some(value => typeof value === 'string' && value.includes('--read-only')));
  assert(firstWorkerGroup, 'MCP did not start the expected writable DB worker');
  const usersBeforeParentCrash = await readUsers();
  assert.equal(usersBeforeParentCrash.length, 1,
    'MCP should hold one shared registration while writable initialization is paused');
  const parentExitPromise = once(mcp, 'exit');
  mcp.kill('SIGKILL');
  const [parentCode, parentSignal] = await parentExitPromise;
  assert.equal(parentSignal, 'SIGKILL');
  const workerGroupAliveAfterParentCrash = await processGroupExists(firstWorkerGroup.pid);
  const workerGroupProcessesAfterParentCrash = processGroupSnapshot(firstWorkerGroup.pid);
  const workerStoppedByHarness = await stopKnownWorkerGroup(firstWorkerGroup.pid);
  assert.equal(await processGroupExists(firstWorkerGroup.pid), false,
    'could not confirm the known fixture DB worker group stopped');
  const usersAfterParentCrash = await readUsers();
  assert.deepEqual(usersAfterParentCrash, usersBeforeParentCrash,
    'SIGKILL unexpectedly removed the parent service shared registration');
  let exclusiveFailure = '';
  try {
    const lock = await strictMaintenanceLock({
      projectRoot,
      indexPath: '.search-docs/index',
      documentsPath: '.search-docs/documents',
      files: config.files,
    });
    const lease = await lock.acquireExclusive();
    await lease.release();
  } catch (error) {
    exclusiveFailure = error.message;
  }
  assert.match(exclusiveFailure, /使用中/);

  const httpEnv = {
    ...env,
    ISSUE183_CHILD_REGISTRY: childRegistry,
  };
  const afterParentCrash = await hashTree(indexPath);
  assert.deepEqual(afterParentCrash, databaseAtBarrier,
    'stopping the paused worker group changed the completed table-boundary snapshot');
  const mcpBefore = await readUsers();
  const mcpRejected = await runFailClosedService('MCP', process.execPath, [
    path.join(repo, 'packages/mcp-server/dist/server.js'),
    '--project-dir',
    projectRoot,
  ], env);
  assert.equal(mcpRejected.sharedUsersBefore, mcpBefore.length);
  assert.equal(mcpRejected.sharedUsersAfter, usersAfterParentCrash.length);
  assert.deepEqual(await hashTree(indexPath), databaseAtBarrier);

  const http = trackChild(children, spawn(process.execPath, [
    path.join(repo, 'packages/server/dist/bin/server.js'),
  ], { cwd: projectRoot, env: httpEnv, stdio: ['ignore', 'pipe', 'pipe'] }));
  let httpStdout = '';
  let httpStderr = '';
  http.stdout.setEncoding('utf8');
  http.stderr.setEncoding('utf8');
  http.stdout.on('data', chunk => { httpStdout += chunk; });
  http.stderr.on('data', chunk => { httpStderr += chunk; });
  const [httpCode, httpSignal] = await waitForExit(http, 'HTTP partial-DB preflight');
  assert.equal(httpCode, 1, `HTTP should fail closed:\n${httpStdout}\n${httpStderr}`);
  assert.match(`${httpStdout}\n${httpStderr}`, /writer_heartbeat/);
  assert.deepEqual(await hashTree(indexPath), databaseAtBarrier,
    'HTTP preflight changed the partial database');
  assert.deepEqual(await readUsers(), usersAfterParentCrash,
    'a cleanly rejected HTTP startup should leave only the stale parent registration');
  const finalChildGroups = await readChildGroups();
  const writableGroupsAfterCrash = finalChildGroups.filter(item =>
    item.args.some(value => typeof value === 'string' && value.includes(path.resolve(indexPath)))
    && !item.args.some(value => typeof value === 'string' && value.includes('--read-only')));
  assert.equal(writableGroupsAfterCrash.length, 1,
    're-diagnosis should not start a new writable worker for the partial DB');
  assert(
    finalChildGroups.filter(item => item.args.some(value => typeof value === 'string'
      && value.includes(path.resolve(indexPath)))).every(item =>
      item.args.some(value => typeof value === 'string' && value.includes('--read-only'))
      || item.pid === firstWorkerGroup.pid),
    'service re-diagnosis started an unexpected writable worker',
  );
  const mcpDebugRedirect = await readFile(path.join(root, 'mcp-debug-redirect.jsonl'), 'utf8');
  assert(mcpDebugRedirect.trim().length > 0, 'MCP debug output was not redirected into fixture root');

  result = {
    process: 'real MCP server and real SearchDocsWorker',
    database: 'new disposable LanceDB under a temporary project',
    fixtureCrashPoint: 'real MCP parent SIGKILL while its real writable SearchDocsWorker was paused after creating embedding_identity and sections, before index_requests and writer_heartbeat',
    parentExit: [parentCode, parentSignal],
    observedTablesAtBarrier: tablesAtBarrier,
    usersBeforeParentCrash: usersBeforeParentCrash.length,
    usersAfterParentCrash: usersAfterParentCrash.length,
    workerGroupAliveAfterParentCrash,
    workerGroupProcessesAfterParentCrash,
    workerStoppedByHarness,
    exclusiveMaintenanceAttemptAfterParentCrash: exclusiveFailure,
    postCrashRecheck: {
      MCP: mcpRejected,
      HTTP: {
        exit: [httpCode, httpSignal],
        failedOnMissingRequiredTable: true,
        databaseTreeUnchanged: true,
        sharedRegistrationCountRemained: usersAfterParentCrash.length,
      },
      newWritableWorkerStarted: false,
    },
    embeddingFixture: {
      implementation: 'loopback fake OpenAI-compatible endpoint; deterministic fixed vectors',
      requests: embeddingRequests,
    },
    fixedDebugLogRedirectedInsideFixture: true,
    differenceFromNativeCrash: 'the service parent was SIGKILLed at an explicit Python barrier after LanceDB create_table returned; native create_table itself was not interrupted',
    limitations: [
      'does not pause inside LanceDB native API',
      'does not simulate kernel crash, reboot, power loss, filesystem durability, shared filesystem, or multi-host',
    ],
  };
} finally {
  let cleanupFailure;
  try {
    await stopTrackedChildren(children, root);
  } catch (error) {
    cleanupFailure = error;
  }
  if (embeddingListening) {
    await new Promise(resolve => embedding.close(() => resolve()));
  }
  if (!cleanupFailure) {
    try {
      const groups = await readChildGroups();
      for (const { pid, args } of groups) {
        if (!args.some(value => typeof value === 'string' && value.includes(path.resolve(indexPath)))) continue;
        if (await processGroupExists(pid)) await stopKnownWorkerGroup(pid);
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) {
    throw new Error(`Harness cleanup failed; preserving temporary data at ${root}`, {
      cause: cleanupFailure,
    });
  }
  if (result) {
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`Harness failed after tracked process cleanup; preserving temporary data at ${root}`);
  }
}

assert(result, 'harness produced no result');
console.log(JSON.stringify({
  ...result,
  cleanup: {
    directChildrenClosed: true,
    knownFixtureWorkerGroupsStopped: true,
    temporaryRootRemovedAfterProcessChecks: true,
  },
}, null, 2));
