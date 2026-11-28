import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dimension = 256;
const root = await mkdtemp(path.join(tmpdir(), 'issue183-identity-mismatch-'));
const projectRoot = path.join(root, 'project');
const binDirectory = path.join(root, 'bin');
const children = new Set();
const usersPath = path.join(projectRoot, '.search-docs/.search-docs-maintenance/users');
const managementPath = path.join(projectRoot, '.search-docs/.search-docs-maintenance');
const indexPath = path.join(projectRoot, '.search-docs/index');
let canonicalIndexPath = indexPath;
const embeddingPidPath = path.join(root, 'embedding-child.pid');
const embeddingReadyPath = path.join(root, 'embedding-ready');
const stopFaultPath = path.join(root, 'stop-fault.json');
const startupFailurePath = path.join(root, 'startup-failure.log');
let seedEmbedding;
let seedEmbeddingListening = false;
let seedEngine;
let mcp;
let mcpStdout = '';
let mcpStderr = '';
let embeddingPid;
let exclusiveLease;
let result;

const pythonEnvironment = path.join(repo, 'packages/db-engine/.venv');
process.env.VIRTUAL_ENV = pythonEnvironment;
process.env.UV_PROJECT_ENVIRONMENT = pythonEnvironment;
process.env.UV_NO_SYNC = '1';
process.env.PYTHONDONTWRITEBYTECODE = '1';

function jsonResponse(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeEmbeddingServer(model) {
  return createServer((request, response) => {
    if (request.url === '/health') {
      jsonResponse(response, { status: 'ok', model, vectorDimension: dimension });
      return;
    }
    if (request.url === '/ready') {
      jsonResponse(response, { status: 'ok', ready: true, model, vectorDimension: dimension });
      return;
    }
    response.writeHead(404).end();
  });
}

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind fixture endpoint');
  return { port: address.port, url: `http://${host}:${address.port}` };
}

async function waitUntil(predicate, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function readUsers() {
  try { return await readdir(usersPath); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function listProcessesUsingFixtureDb() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' });
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || !match[4].includes(`--db-path=${canonicalIndexPath}`)) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), processGroup: Number(match[3]), command: match[4] }];
  });
}

function processGroupMembers(pid) {
  const output = execFileSync('ps', ['-axo', 'pid=,pgid=,stat=,command='], { encoding: 'utf8' });
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || Number(match[2]) !== pid || !match[4].includes(root)) return [];
    return [{ pid: Number(match[1]), processGroup: Number(match[2]), state: match[3], command: match[4] }];
  });
}

async function childGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return processGroupMembers(pid).length > 0;
    throw error;
  }
}

async function stopFixtureEmbeddingGroup(pid) {
  const members = processGroupMembers(pid);
  if (members.length === 0) return;
  if (!members.some(member => member.pid === pid && member.command.includes('embedding-fixture.mjs'))) {
    throw new Error(`Refusing to signal process group ${pid}; its owner does not match this fixture: ${JSON.stringify(members)}`);
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await waitUntil(async () => processGroupMembers(pid).length === 0,
    `could not confirm fixture process group ${pid} stopped`, 5000);
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

async function healthStatus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
  return response.status;
}

try {
  const { DBEngine, MaintenanceLock } = await import(pathToFileURL(
    path.join(repo, 'packages/db-engine/dist/index.js'),
  ).href);
  const { DEFAULT_CONFIG } = await import(pathToFileURL(
    path.join(repo, 'packages/types/dist/index.js'),
  ).href);

  await mkdir(path.join(projectRoot, '.search-docs/documents'), { recursive: true });
  await writeFile(path.join(projectRoot, 'fixture.md'), '# Disposable fixture\n');

  seedEmbedding = makeEmbeddingServer('issue183-seed-model');
  const seedEndpoint = await listen(seedEmbedding);
  seedEmbeddingListening = true;
  seedEngine = new DBEngine({
    dbPath: indexPath,
    embeddingUrl: seedEndpoint.url,
    embeddingDimension: dimension,
    pythonMaxMemoryMB: undefined,
  });
  await seedEngine.connect();
  await seedEngine.disconnect();
  seedEngine = undefined;
  canonicalIndexPath = await realpath(indexPath);
  await new Promise(resolve => seedEmbedding.close(() => resolve()));
  seedEmbeddingListening = false;

  const config = structuredClone(DEFAULT_CONFIG);
  config.project = { ...config.project, name: 'issue183-identity-mismatch', root: projectRoot };
  config.files = {
    ...config.files,
    sources: ['*.md'],
    exclude: [],
    respectGitignore: false,
  };
  config.storage = {
    ...config.storage,
    indexPath: '.search-docs/index',
    documentsPath: '.search-docs/documents',
  };
  config.indexing = {
    ...config.indexing,
    embeddingUrl: undefined,
    vectorDimension: dimension,
  };
  config.worker = { ...config.worker, enabled: false };
  config.watcher = { ...config.watcher, enabled: false };
  await writeFile(path.join(projectRoot, '.search-docs.json'), JSON.stringify(config, null, 2));

  const portProbe = createServer();
  const { port: localEmbeddingPort } = await listen(portProbe);
  await new Promise(resolve => portProbe.close(() => resolve()));

  await mkdir(binDirectory, { recursive: true });
  const realUvPath = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
  assert(realUvPath, 'could not resolve the real uv executable');
  const fakeEmbeddingPath = path.join(root, 'embedding-fixture.mjs');
  await writeFile(fakeEmbeddingPath, `import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const port = Number(process.argv.find(value => value.startsWith('--port='))?.split('=')[1]);
if (!Number.isInteger(port) || port < 1) throw new Error('missing fixture port');
writeFileSync(process.env.ISSUE183_EMBEDDING_PID_FILE, String(process.pid));
const reply = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
const server = createServer((req, res) => {
  if (req.url === '/health') return reply(res, { status: 'ok', model: 'issue183-service-model', vectorDimension: ${dimension} });
  if (req.url === '/ready') {
    if (existsSync(process.env.ISSUE183_EMBEDDING_READY_FILE)) return reply(res, { status: 'ok', ready: true, model: 'issue183-service-model', vectorDimension: ${dimension} });
    return res.writeHead(503).end(JSON.stringify({ status: 'starting', ready: false }));
  }
  res.writeHead(404).end();
});
server.listen(port, () => process.stderr.write('FIXTURE_EMBEDDING_LISTENING\\\\n'));
process.on('SIGTERM', () => {});
`);
  const fakeUvPath = path.join(binDirectory, 'uv');
  await writeFile(fakeUvPath, `#!/bin/sh
case "$*" in
  *embedding_server.py*) exec ${shellQuote(process.execPath)} ${shellQuote(fakeEmbeddingPath)} "$@" ;;
  *) exec ${shellQuote(realUvPath)} "$@" ;;
esac
`);
  await chmod(fakeUvPath, 0o755);

  const serverModuleUrl = pathToFileURL(path.join(repo, 'packages/server/dist/index.js')).href;
  const serverWrapperPath = path.join(root, 'server-wrapper.mjs');
  await writeFile(serverWrapperPath, `
import { EmbeddingServerProcess as BaseEmbeddingServerProcess } from ${JSON.stringify(serverModuleUrl)};
export * from ${JSON.stringify(serverModuleUrl)};
export class EmbeddingServerProcess extends BaseEmbeddingServerProcess {
  constructor(options) {
    super({ ...options, port: Number(process.env.ISSUE183_EMBEDDING_PORT) });
  }
}
`);

  const loaderPath = path.join(root, 'server-loader.mjs');
  await writeFile(loaderPath, `import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@search-docs/server') {
    return { url: pathToFileURL(process.env.ISSUE183_SERVER_WRAPPER).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);

  const preloadPath = path.join(root, 'stop-fault-preload.mjs');
await writeFile(preloadPath, `import { createRequire } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const originalStringify = JSON.stringify.bind(JSON);
JSON.stringify = function(value, ...args) {
  const isMcpServer = process.argv.some(item => item.endsWith('/packages/mcp-server/dist/server.js'));
  if (isMcpServer && value instanceof Error) {
    return originalStringify({ name: value.name, message: value.message, stack: value.stack }, ...args);
  }
  return originalStringify(value, ...args);
};
const originalAppendFileSync = fs.appendFileSync.bind(fs);
fs.appendFileSync = function(file, data, ...args) {
  const isMcpServer = process.argv.some(value => value.endsWith('/packages/mcp-server/dist/server.js'));
  if (isMcpServer && file === '/tmp/mcp-server-debug.log') {
    originalAppendFileSync(process.env.ISSUE183_STARTUP_FAILURE_FILE, data);
  }
  return originalAppendFileSync(file, data, ...args);
};
const originalKill = process.kill.bind(process);
process.kill = function(pid, signal) {
  const isMcpServer = process.argv.some(value => value.endsWith('/packages/mcp-server/dist/server.js'));
  if (isMcpServer && signal === 'SIGTERM' && typeof pid === 'number' && pid < -1) {
    let target;
    try { target = Number(readFileSync(process.env.ISSUE183_EMBEDDING_PID_FILE, 'utf8')); }
    catch { return originalKill(pid, signal); }
    if (target > 1 && pid === -target) {
      appendFileSync(process.env.ISSUE183_STOP_FAULT_FILE, JSON.stringify({
        pid: target, signal, code: 'EPERM', at: new Date().toISOString(),
      }));
      const error = new Error('injected EPERM while stopping the fixture local embedding child');
      error.code = 'EPERM';
      throw error;
    }
  }
  return originalKill(pid, signal);
};
`);

  const env = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH}`,
    VIRTUAL_ENV: pythonEnvironment,
    UV_PROJECT_ENVIRONMENT: pythonEnvironment,
    UV_NO_SYNC: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    ISSUE183_EMBEDDING_PID_FILE: embeddingPidPath,
    ISSUE183_EMBEDDING_READY_FILE: embeddingReadyPath,
    ISSUE183_EMBEDDING_PORT: String(localEmbeddingPort),
    ISSUE183_SERVER_WRAPPER: serverWrapperPath,
    ISSUE183_STOP_FAULT_FILE: stopFaultPath,
    ISSUE183_STARTUP_FAILURE_FILE: startupFailurePath,
    NODE_OPTIONS: [
      `--experimental-loader=${pathToFileURL(loaderPath).href}`,
      `--import=${pathToFileURL(preloadPath).href}`,
    ].join(' '),
  };

  mcp = trackChild(children, spawn(process.execPath, [
    path.join(repo, 'packages/mcp-server/dist/server.js'),
    '--project-dir',
    projectRoot,
  ], {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
  mcp.stdout.setEncoding('utf8');
  mcp.stderr.setEncoding('utf8');
  mcp.stdout.on('data', chunk => { mcpStdout += chunk; });
  mcp.stderr.on('data', chunk => { mcpStderr += chunk; });
  embeddingPid = await waitUntil(async () => {
    try { return Number(await readFile(embeddingPidPath, 'utf8')); }
    catch {
      if (mcp.exitCode !== null || mcp.signalCode !== null) {
        const failureLog = await readFile(path.join(projectRoot, '.search-docs/server.log'), 'utf8').catch(() => '');
        throw new Error(`MCP exited before starting the fixture embedding child (code=${mcp.exitCode}, signal=${mcp.signalCode})\nstdout:\n${mcpStdout}\nstderr:\n${mcpStderr}\nserver log:\n${failureLog}`);
      }
      return undefined;
    }
  }, 'fixture local embedding child did not start');
  assert(embeddingPid > 1, `invalid fixture embedding PID ${embeddingPid}`);
  const usersBeforeFailure = await waitUntil(async () => {
    const users = await readUsers();
    return users.length > 0 ? users : undefined;
  }, 'shared registration was not present while embedding startup was paused');
  assert(usersBeforeFailure.length > 0, 'shared registration was not present while DBEngine connected');
  await writeFile(embeddingReadyPath, 'continue');

  const contender = new MaintenanceLock(managementPath);
  let acquisitionAttempts = 0;
  const exclusiveResult = (async () => {
    while (acquisitionAttempts < 2000) {
      acquisitionAttempts++;
      try {
        const lease = await contender.acquireExclusive();
        exclusiveLease = lease;
        const usersAtGrant = await readUsers();
        const childAliveAtGrant = await childGroupExists(embeddingPid);
        const childHealthAtGrant = await healthStatus(localEmbeddingPort);
        const databaseProcessesAtGrant = listProcessesUsingFixtureDb();
        let childOpenDatabasePath;
        try {
          const output = execFileSync('lsof', ['-nP', '-p', String(embeddingPid)], { encoding: 'utf8' });
          childOpenDatabasePath = output.includes(canonicalIndexPath);
        } catch (error) {
          childOpenDatabasePath = error.status === 1 ? false : null;
        }
        return {
          usersAtGrant: usersAtGrant.length,
          exclusiveDirectoryPresent: await stat(path.join(managementPath, 'exclusive')).then(() => true),
          childAliveAtGrant,
          childHealthStatusAtGrant: childHealthAtGrant,
          childProcessAtGrant: processInfo(embeddingPid),
          childOpenDatabasePath,
          databaseProcessesAtGrant,
          acquisitionAttempts,
        };
      } catch (error) {
        if (!/データを使用中|管理領域は使用中/.test(String(error))) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    throw new Error('exclusive contender timed out before shared registration was released');
  })();

  await waitUntil(async () => {
    try {
      const fault = JSON.parse(await readFile(stopFaultPath, 'utf8'));
      return fault.pid === embeddingPid && fault.code === 'EPERM';
    } catch { return false; }
  }, 'the service did not attempt to stop the fixture embedding child');
  await waitUntil(async () => (await readUsers()).length === 0,
    'shared registration remained after the embedding shutdown failure');
  await waitUntil(async () => {
    const text = await readFile(startupFailurePath, 'utf8').catch(() => '');
    return text.includes('Embedding provider, model, endpoint or dimension differs from the index');
  }, 'the expected embedding identity mismatch was not reported');

  const grant = await exclusiveResult;
  const log = await readFile(path.join(projectRoot, '.search-docs/server.log'), 'utf8');
  const workerExitLines = log.split('\n').filter(line => line.includes('Python worker exited'));
  const registeredUsersAfter = await readUsers();
  result = {
    injectedFailure: JSON.parse(await readFile(stopFaultPath, 'utf8')),
    embeddingIdentityMismatchObserved: true,
    sharedUsersBeforeFailure: usersBeforeFailure.length,
    sharedUsersAfterFailure: registeredUsersAfter.length,
    exclusiveGrant: grant,
    dbEngineWorkerExitLogLines: workerExitLines.length,
    fixtureEmbeddingProcessStillServing: await healthStatus(localEmbeddingPort) === 200,
    mcpProcessAliveAfterStartupFailure: mcp.exitCode === null && mcp.signalCode === null,
  };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(grant.usersAtGrant, 0, 'exclusive was granted while shared registrations remained');
  assert.equal(grant.exclusiveDirectoryPresent, true);
  assert.equal(grant.childAliveAtGrant, true, 'fixture child was not alive during exclusive maintenance acquisition');
  assert.equal(grant.childHealthStatusAtGrant, 200, 'fixture child stopped serving HTTP before maintenance acquisition');
  assert.equal(result.sharedUsersAfterFailure, 0);
  assert(result.dbEngineWorkerExitLogLines >= 2, `expected strict-diagnostic and DBEngine worker exits; saw ${workerExitLines.length}`);
  assert.equal(result.fixtureEmbeddingProcessStillServing, true);
} finally {
  let cleanupFailure;
  if (exclusiveLease) {
    try { await exclusiveLease.release(); }
    catch (error) { cleanupFailure = error; }
  }
  try { await stopTrackedChildren(children, root); }
  catch (error) { cleanupFailure ??= error; }
  if (!embeddingPid) {
    try { embeddingPid = Number(await readFile(embeddingPidPath, 'utf8')); }
    catch {}
  }
  if (embeddingPid > 1) {
    try { await stopFixtureEmbeddingGroup(embeddingPid); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (seedEngine) {
    try { await seedEngine.disconnect(); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (seedEmbeddingListening) {
    try { await new Promise((resolve, reject) => seedEmbedding.close(error => error ? reject(error) : resolve())); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (cleanupFailure) {
    throw new Error(`Fixture cleanup was not confirmed; preserving temporary root ${root}`, { cause: cleanupFailure });
  }
  const lingeringDbProcesses = listProcessesUsingFixtureDb();
  if (lingeringDbProcesses.length > 0) {
    throw new Error(`Fixture DB workers remain; preserving temporary root ${root}: ${JSON.stringify(lingeringDbProcesses)}`);
  }
  await rm(root, { recursive: true, force: true });
}

if (embeddingPid) assert.equal(await childGroupExists(embeddingPid), false, 'fixture embedding process group survived cleanup');
await assert.rejects(stat(root), { code: 'ENOENT' });
console.log(JSON.stringify({
  ...result,
  cleanup: { fixtureProcessesStopped: true, temporaryRootRemovedAfterConfirmation: true },
}, null, 2));
