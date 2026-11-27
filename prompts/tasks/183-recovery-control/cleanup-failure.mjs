import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'issue183-cleanup-failure-'));
const children = new Set();
let child;
let observedFailure;

try {
  child = trackChild(children, spawn(process.execPath, [
    '-e',
    "process.stdout.write('READY\\\\n'); setInterval(() => {}, 1000);",
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  let output = '';
  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', data => {
        output += data.toString();
        if (output.includes('READY')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`child exited before READY: ${code}/${signal}`)));
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for READY')), 5000);
      timer.unref();
    }),
  ]);
  throw new Error('intentional failure after child startup');
} catch (error) {
  observedFailure = error;
} finally {
  await stopTrackedChildren(children, root);
  await rm(root, { recursive: true, force: true });
}

assert.match(observedFailure?.message ?? '', /intentional failure/);
assert.equal(child.signalCode, 'SIGKILL', 'cleanup did not confirm termination of the test child');
await assert.rejects(stat(root), { code: 'ENOENT' });
console.log(JSON.stringify({
  inducedFailure: observedFailure.message,
  childExitSignal: child.signalCode,
  temporaryRootRemovedAfterChildClose: true,
}, null, 2));
