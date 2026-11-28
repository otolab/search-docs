import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopProcessGroup, stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const lockSource = await readFile(path.join(repo, 'packages/db-engine/src/typescript/maintenance-lock.ts'), 'utf8');
const root = await mkdtemp(path.join(tmpdir(), 'issue183-shared-holder-'));
const dbPath = path.join(root, 'index');
const controlPath = path.join(root, 'control');
const identity = 'issue183-disposable-shared-holder';
const children = new Set();
let sharedLease;
let preserveRoot = false;

const lockModulePath = path.join(root, 'maintenance-lock.mjs');
await writeFile(lockModulePath, ts.transpileModule(lockSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText);
const lockModuleUrl = pathToFileURL(lockModulePath).href;
const workerSource = `
import { createInterface } from 'node:readline';
import { readdir } from 'node:fs/promises';
import { MaintenanceLock } from ${JSON.stringify(lockModuleUrl)};

const [controlPath, dbPath, identity] = process.argv.slice(1);
const lock = new MaintenanceLock(controlPath, identity);
const input = createInterface({ input: process.stdin });
const pending = [];
const waiters = [];
input.on('line', line => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else pending.push(line);
});
function command() {
  if (pending.length) return Promise.resolve(pending.shift());
  return new Promise(resolve => waiters.push(resolve));
}
function emit(event, details = {}) {
  process.stdout.write(JSON.stringify({ event, ...details }) + '\\n');
}
async function tables() {
  let entries;
  try { entries = await readdir(dbPath, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isDirectory() && entry.name.endsWith('.lance'))
    .map(entry => entry.name.slice(0, -'.lance'.length)).sort();
}

emit('PREFLIGHT', { tables: await tables() });
if (await command() !== 'GO') throw new Error('unexpected controller command');
let lease;
let attempts = 0;
while (!lease) {
  try {
    lease = await lock.acquireExclusive();
    emit('EXCLUSIVE_ACQUIRED', { attempts });
  } catch (error) {
    attempts += 1;
    emit('EXCLUSIVE_BLOCKED', { attempts, reason: error.message });
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
emit('POST_LOCK_RECHECK', { tables: await tables() });
await lease.release();
emit('DONE');
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
  return pattern => {
    const index = lines.findIndex(line => pattern.test(line));
    if (index >= 0) return Promise.resolve(JSON.parse(lines.splice(index, 1)[0]));
    return new Promise((resolve, reject) => {
      const waiter = { pattern, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error(`timeout waiting for ${pattern}`));
      }, 10000);
      waiters.push(waiter);
    });
  };
}

const child = trackChild(children, spawn(process.execPath, [
  '--input-type=module', '-e', workerSource, controlPath, dbPath, identity,
], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));
const closed = once(child, 'close');
const next = observe(child);
const holderLock = new (await import(lockModuleUrl)).MaintenanceLock(controlPath, identity);
const fixtureTables = ['embedding_identity', 'index_requests', 'sections', 'writer_heartbeat'];

try {
  const preflight = await next(/"event":"PREFLIGHT"/);
  assert.deepEqual(preflight.tables, [], 'waiter should observe the uninitialized fixture before the winner');

  const initialExclusive = await holderLock.acquireExclusive();
  for (const table of fixtureTables) await mkdir(path.join(dbPath, `${table}.lance`), { recursive: true });
  await initialExclusive.release();

  // Model the initializer becoming a long-lived normal service before the
  // contender retries its stale "needs initialization" exclusive decision.
  sharedLease = await holderLock.acquireShared();
  child.stdin.write('GO\n');
  const blocked = [];
  for (let index = 0; index < 4; index += 1) {
    blocked.push(await next(/"event":"EXCLUSIVE_BLOCKED"/));
  }
  assert(blocked.every(event => /データを使用中/.test(event.reason)),
    `unexpected exclusive block: ${JSON.stringify(blocked)}`);

  await sharedLease();
  sharedLease = undefined;
  const acquired = await next(/"event":"EXCLUSIVE_ACQUIRED"/);
  const recheck = await next(/"event":"POST_LOCK_RECHECK"/);
  assert.deepEqual(recheck.tables, fixtureTables);
  await next(/"event":"DONE"/);
  const [code, signal] = await closed;
  assert.equal(code, 0);
  assert.equal(signal, null);

  console.log(JSON.stringify({
    scope: 'one independent waiter process plus a parent-process shared holder; existing MaintenanceLock source transpiled into a disposable temp root; synthetic table directories only',
    waiterPreflight: preflight.tables,
    winnerPublishedReadyFixtureBeforeSharedAdmission: fixtureTables,
    exclusiveRetriesWhileLongLivedSharedHolderPresent: blocked.length,
    exclusiveAcquiredOnlyAfterSharedRelease: acquired.attempts > 0,
    postExclusiveRecheck: recheck.tables,
    productCodeChanged: false,
  }, null, 2));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (sharedLease) await sharedLease().catch(() => {});
  try {
    if (child.pid) await stopProcessGroup(child.pid);
    await stopTrackedChildren(children, root);
  } catch (error) {
    preserveRoot = true;
    console.error(error);
  }
  if (!preserveRoot) await rm(root, { recursive: true, force: true });
  else console.error(`Preserved disposable root because child stop was not confirmed: ${root}`);
}
