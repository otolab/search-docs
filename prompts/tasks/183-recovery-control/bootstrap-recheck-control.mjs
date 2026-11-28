import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopProcessGroup, stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const python = path.join(repo, 'packages/db-engine/.venv/bin/python');
const lockSource = await readFile(path.join(repo, 'packages/db-engine/src/typescript/maintenance-lock.ts'), 'utf8');
const root = await mkdtemp(path.join(tmpdir(), 'issue183-bootstrap-recheck-'));
const dbPath = path.join(root, 'index');
const controlPath = path.join(root, 'control');
const identity = 'issue183-disposable-bootstrap';
const children = new Set();
let preserveRoot = false;

const lockModulePath = path.join(root, 'maintenance-lock.mjs');
await writeFile(lockModulePath, ts.transpileModule(lockSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText);
const lockModuleUrl = pathToFileURL(lockModulePath).href;

const workerSource = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir } from 'node:fs/promises';
import { MaintenanceLock } from ${JSON.stringify(lockModuleUrl)};

const [controlPath, dbPath, identity, python, workerId] = process.argv.slice(1);
const lock = new MaintenanceLock(controlPath, identity);
const required = ['embedding_identity', 'sections', 'index_requests', 'writer_heartbeat'];
const input = createInterface({ input: process.stdin });
const pendingCommands = [];
const commandWaiters = [];
input.on('line', line => {
  const waiter = commandWaiters.shift();
  if (waiter) waiter(line);
  else pendingCommands.push(line);
});
function nextCommand() {
  if (pendingCommands.length) return Promise.resolve(pendingCommands.shift());
  return new Promise(resolve => commandWaiters.push(resolve));
}
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function tableDirectories() {
  let entries;
  try { entries = await readdir(dbPath, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.lance'))
    .map(entry => entry.name.slice(0, -'.lance'.length))
    .sort();
}
function emit(event, details = {}) {
  process.stdout.write(JSON.stringify({ workerId, event, ...details }) + '\\n');
}

const beforeLock = await tableDirectories();
emit('PREFLIGHT', { tables: beforeLock });
assert.equal(await nextCommand(), 'GO');

let lease;
let announcedWait = false;
while (!lease) {
  try {
    lease = await lock.acquireExclusive();
  } catch (error) {
    if (!announcedWait) {
      emit('WAITING', { reason: error.message });
      announcedWait = true;
    }
    await pause(25);
  }
}
emit('LOCKED');

let afterLock = await tableDirectories();
if (!required.every(name => afterLock.includes(name))) {
  emit('NEEDS_CHANGE', { tables: afterLock });
  assert.equal(await nextCommand(), 'MUTATE');
  const createTables = \`
import lancedb, sys
db = lancedb.connect(sys.argv[1])
for name in ['embedding_identity', 'sections', 'index_requests', 'writer_heartbeat']:
    if name not in db.table_names():
        db.create_table(name, data=[{'fixture_key': name}])
\`;
  execFileSync(python, ['-c', createTables, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  afterLock = await tableDirectories();
  assert(required.every(name => afterLock.includes(name)), 'fixture tables were not fully created');
  emit('MUTATED_AND_VERIFIED', { tables: afterLock });
} else {
  emit('RECHECK_READY', { tables: afterLock });
}
await lease.release();
emit('EXCLUSIVE_RELEASED');

let releaseShared;
while (!releaseShared) {
  try { releaseShared = await lock.acquireShared(); }
  catch { await pause(25); }
}
emit('NORMAL_ADMITTED');
await releaseShared();
input.close();
`;

function observe(child) {
  let buffer = '';
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiterIndex = waiters.findIndex(waiter => waiter.pattern.test(line));
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(JSON.parse(line));
      } else {
        lines.push(line);
      }
    }
  });
  return (pattern, timeoutMs = 15000) => {
    const index = lines.findIndex(line => pattern.test(line));
    if (index >= 0) return Promise.resolve(JSON.parse(lines.splice(index, 1)[0]));
    return new Promise((resolve, reject) => {
      const waiter = { pattern, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error(`timeout waiting for ${pattern}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

function startWorker(workerId) {
  const child = trackChild(children, spawn(process.execPath, [
    '--input-type=module', '-e', workerSource,
    controlPath, dbPath, identity, python, workerId,
  ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  return { child, closed: once(child, 'close'), next: observe(child) };
}

try {
  const workers = [startWorker('A'), startWorker('B')];
  const preflights = await Promise.all(workers.map(worker => worker.next(/"event":"PREFLIGHT"/)));
  assert.deepEqual(preflights.map(event => event.tables), [[], []],
    'both contenders should observe the absent DB before admission');
  workers.forEach(worker => worker.child.stdin.write('GO\n'));

  const firstLock = await Promise.race(workers.map(async worker => ({
    worker,
    event: await worker.next(/"event":"LOCKED"/),
  })));
  const contender = workers.find(worker => worker !== firstLock.worker);
  const waiting = await contender.next(/"event":"WAITING"/);
  assert.match(waiting.reason, /保守操作が実行中/);

  const ownerChange = firstLock.worker.next(/"event":"NEEDS_CHANGE"/);
  firstLock.worker.child.stdin.write('MUTATE\n');
  const mutation = await ownerChange;
  assert.deepEqual(mutation.tables, []);

  const ownerVerified = await firstLock.worker.next(/"event":"MUTATED_AND_VERIFIED"/);
  assert.deepEqual(ownerVerified.tables, [
    'embedding_identity', 'index_requests', 'sections', 'writer_heartbeat',
  ]);
  await firstLock.worker.next(/"event":"EXCLUSIVE_RELEASED"/);
  const contenderRecheck = await contender.next(/"event":"RECHECK_READY"/);
  assert.deepEqual(contenderRecheck.tables, ownerVerified.tables,
    'the waiting starter should re-read the completed state after acquiring exclusivity');

  const admitted = await Promise.all(workers.map(worker => worker.next(/"event":"NORMAL_ADMITTED"/)));
  assert.equal(admitted.length, 2);
  const exits = await Promise.all(workers.map(worker => worker.closed));
  assert(exits.every(([code, signal]) => code === 0 && signal === null),
    `worker exit results: ${JSON.stringify(exits)}`);

  console.log(JSON.stringify({
    scope: 'two disposable local processes; current MaintenanceLock source transpiled to temp; synthetic table names in a new LanceDB DB; no product source changed',
    initialReadOnlyPreflight: preflights.map(event => event.tables),
    exclusiveWinner: firstLock.event.workerId,
    competingStarter: waiting.workerId,
    mutationCount: 1,
    winnerPostLock: ownerVerified.tables,
    waiterPostLockRecheck: contenderRecheck.tables,
    bothEnteredSharedNormalUse: true,
  }, null, 2));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  try {
    await Promise.all([...children].map(child =>
      child.pid ? stopProcessGroup(child.pid) : Promise.resolve()));
    await stopTrackedChildren(children, root);
  } catch (error) {
    preserveRoot = true;
    console.error(error);
  }
  if (!preserveRoot) await rm(root, { recursive: true, force: true });
  else console.error(`Preserved disposable root because child stop was not confirmed: ${root}`);
}
