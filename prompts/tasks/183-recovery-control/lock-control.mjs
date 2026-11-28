import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stopTrackedChildren, trackChild } from './harness-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const sourcePath = path.join(repo, 'packages/db-engine/src/typescript/maintenance-lock.ts');
const source = await readFile(sourcePath, 'utf8');
const injected = source
  .replace(
    "import { randomUUID } from 'node:crypto';",
    "import { randomUUID } from 'node:crypto';\nasync function pauseAt(point: string) { if (process.env.ISSUE183_PAUSE === point) { process.stdout.write(`PAUSED:${point}\\n`); await new Promise<void>(resolve => process.once('SIGUSR1', resolve)); } }",
  )
  .replace('await mkdir(this.gate);\n        break;', "await mkdir(this.gate);\n        await pauseAt('gate');\n        break;")
  .replace(
    'await mkdir(registration);\n      if (this.identity)',
    "await mkdir(registration);\n      await pauseAt('registration');\n      if (this.identity)",
  )
  .replace(
    "try { await writeFile(identityPath, this.identity, { flag: 'wx', mode: 0o600 }); }",
    "try { await writeFile(identityPath, this.identity, { flag: 'wx', mode: 0o600 }); await pauseAt('identity'); }",
  );
assert.notEqual(injected, source, 'maintenance-lock instrumentation did not match');
assert(injected.includes("await pauseAt('identity')"), 'identity pause was not injected');

const root = await mkdtemp(path.join(tmpdir(), 'issue183-lock-control-'));
const children = new Set();
try {
const modulePath = path.join(root, 'maintenance-lock.mjs');
await writeFile(modulePath, ts.transpileModule(injected, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText);
const moduleUrl = pathToFileURL(modulePath).href;
const results = {
  crashWindows: [],
  completedRegistrationAfterOwnerSigkill: null,
  maintenanceCrashWindows: [],
  raceTrials: 0,
  wins: { shared: 0, exclusive: 0 },
};

function waitForLine(child, pattern, timeoutMs = 10000) {
  let buffer = '';
  return Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', data => {
        buffer += data.toString();
        const line = buffer.split('\n').find(item => pattern.test(item));
        if (line) resolve(line);
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`child exited before ${pattern}: ${code}/${signal}; ${buffer}`)));
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern}`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

async function attempt(action) {
  try {
    await action();
    return 'allowed';
  } catch (error) {
    return `denied: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const crashScript = `import { MaintenanceLock } from ${JSON.stringify(moduleUrl)};
const [directory, identity] = process.argv.slice(1);
const lock = new MaintenanceLock(directory, identity);
await lock.acquireShared();
process.stdout.write('ACQUIRED\\n');
setInterval(() => {}, 1000);`;

  for (const point of ['gate', 'registration', 'identity']) {
    const directory = path.join(root, `shared-${point}`);
    const identity = 'same-project-config';
    const child = trackChild(children, spawn(process.execPath, ['--input-type=module', '-e', crashScript, directory, identity], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ISSUE183_PAUSE: point },
    }));
    await waitForLine(child, new RegExp(`^PAUSED:${point}$`));
    await killChild(child);

    const usersPath = path.join(directory, 'users');
    const users = await readdir(usersPath);
    const state = {
      gateRemains: await (async () => {
        try { await readFile(path.join(directory, 'gate')); return true; }
        catch (error) { if (error.code === 'EISDIR') return true; if (error.code === 'ENOENT') return false; throw error; }
      })(),
      users: await Promise.all(users.map(async user => {
        try { return { user, identity: await readFile(path.join(usersPath, user, 'identity'), 'utf8') }; }
        catch (error) { return { user, identityError: error.code }; }
      })),
    };
    const { MaintenanceLock } = await import(moduleUrl);
    const lock = new MaintenanceLock(directory, identity);
    const sharedWhileGateRemains = await attempt(() => lock.acquireShared());
    await rmdir(path.join(directory, 'gate'));
    let afterManualGateRemoval;
    if (point === 'gate') {
      const release = await lock.acquireShared();
      await release();
      const exclusive = await new MaintenanceLock(directory).acquireExclusive();
      await exclusive.release();
      afterManualGateRemoval = { shared: 'allowed', exclusive: 'allowed' };
    } else if (point === 'registration') {
      afterManualGateRemoval = {
        shared: await attempt(() => lock.acquireShared()),
        exclusive: await attempt(() => new MaintenanceLock(directory).acquireExclusive()),
      };
    } else {
      const release = await lock.acquireShared();
      afterManualGateRemoval = {
        sameIdentityShared: 'allowed',
        differentIdentityShared: await attempt(() => new MaintenanceLock(directory, 'different-config').acquireShared()),
        exclusive: await attempt(() => new MaintenanceLock(directory).acquireExclusive()),
      };
      await release();
    }
    results.crashWindows.push({ point, stateAfterSigkill: state, sharedWhileGateRemains, afterManualGateRemoval });
  }

  {
    const directory = path.join(root, 'shared-completed-owner');
    const identity = 'same-project-config';
    const child = trackChild(children, spawn(process.execPath, ['--input-type=module', '-e', crashScript, directory, identity], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    await waitForLine(child, /^ACQUIRED$/);
    await killChild(child);

    const { MaintenanceLock } = await import(moduleUrl);
    const lock = new MaintenanceLock(directory, identity);
    const usersPath = path.join(directory, 'users');
    const usersAfterOwnerExit = await readdir(usersPath);
    let releaseCompatibleShared;
    const compatibleShared = await attempt(async () => {
      releaseCompatibleShared = await lock.acquireShared();
    });
    const differentIdentityShared = await attempt(() =>
      new MaintenanceLock(directory, 'different-config').acquireShared());
    const exclusive = await attempt(() => new MaintenanceLock(directory).acquireExclusive());
    if (releaseCompatibleShared) await releaseCompatibleShared();
    const usersAfterCompatibleRelease = await readdir(usersPath);

    assert.equal(usersAfterOwnerExit.length, 1, 'owner SIGKILL should leave its completed registration');
    assert.equal(compatibleShared, 'allowed', 'a compatible shared process may join stale registration');
    assert.match(differentIdentityShared, /^denied:/, 'stale identity should reject incompatible shared use');
    assert.match(exclusive, /^denied:/, 'stale registration should block exclusive maintenance');
    assert.equal(usersAfterCompatibleRelease.length, 1, 'releasing the new owner must not remove the stale entry');
    results.completedRegistrationAfterOwnerSigkill = {
      staleRegistrationsAfterOwnerExit: usersAfterOwnerExit.length,
      compatibleShared,
      differentIdentityShared,
      exclusive,
      staleRegistrationsAfterCompatibleRelease: usersAfterCompatibleRelease.length,
      automaticRecovery: false,
    };
  }

  for (const point of ['exclusive-only', 'exclusive-and-incomplete']) {
    const directory = path.join(root, `maintenance-${point}`);
    const script = `import { MaintenanceLock } from ${JSON.stringify(moduleUrl)};
const lock = new MaintenanceLock(process.argv[1]);
const lease = await lock.acquireExclusive();
${point === 'exclusive-and-incomplete' ? 'await lease.markIncomplete();' : ''}
process.stdout.write('HELD\\n');
setInterval(() => {}, 1000);`;
    const child = trackChild(children, spawn(process.execPath, ['--input-type=module', '-e', script, directory], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    await waitForLine(child, /^HELD$/);
    await killChild(child);
    const { MaintenanceLock } = await import(moduleUrl);
    const lock = new MaintenanceLock(directory);
    const incompleteRemains = await (async () => {
      try { await readFile(path.join(directory, 'incomplete')); return true; }
      catch (error) { if (error.code === 'EISDIR') return true; if (error.code === 'ENOENT') return false; throw error; }
    })();
    const sharedBeforeManualExclusiveRemoval = await attempt(async () => {
      const release = await lock.acquireShared();
      await release();
    });
    await rmdir(path.join(directory, 'exclusive'));
    const afterManualExclusiveRemoval = {
      shared: await attempt(async () => {
        const release = await lock.acquireShared();
        await release();
      }),
      requireComplete: await attempt(async () => {
        const lease = await lock.acquireExclusive({ requireComplete: true });
        await lease.release();
      }),
    };
    let internalRetry;
    if (incompleteRemains) {
      const lease = await lock.acquireExclusive();
      await lease.markIncomplete();
      await lease.complete();
      await lease.release();
      const release = await lock.acquireShared();
      await release();
      internalRetry = 'allowed after complete()';
    }
    results.maintenanceCrashWindows.push({
      point,
      incompleteRemains,
      sharedBeforeManualExclusiveRemoval,
      afterManualExclusiveRemoval,
      internalRetry,
    });
  }

  const contender = `import { MaintenanceLock } from ${JSON.stringify(moduleUrl)};
const [directory, mode] = process.argv.slice(1);
const lock = new MaintenanceLock(directory, 'same-project-config');
process.stdout.write('READY\\n');
await new Promise(resolve => process.stdin.once('data', resolve));
try {
  const held = mode === 'shared' ? await lock.acquireShared() : await lock.acquireExclusive();
  process.stdout.write('WON\\n');
  setInterval(() => {}, 1000);
} catch (error) {
  process.stdout.write('LOST:' + error.message + '\\n');
}`;
  for (let i = 0; i < 20; i++) {
    const directory = path.join(root, `race-${i}`);
    const shared = trackChild(children, spawn(process.execPath, ['--input-type=module', '-e', contender, directory, 'shared'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    const exclusive = trackChild(children, spawn(process.execPath, ['--input-type=module', '-e', contender, directory, 'exclusive'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    await Promise.all([waitForLine(shared, /^READY$/), waitForLine(exclusive, /^READY$/)]);
    shared.stdin.write('go');
    exclusive.stdin.write('go');
    const [sharedResult, exclusiveResult] = await Promise.all([
      waitForLine(shared, /^(WON|LOST:)/),
      waitForLine(exclusive, /^(WON|LOST:)/),
    ]);
    assert.equal([sharedResult, exclusiveResult].filter(line => line === 'WON').length, 1,
      `expected exactly one winner, got ${sharedResult} / ${exclusiveResult}`);
    results.raceTrials++;
    results.wins[sharedResult === 'WON' ? 'shared' : 'exclusive']++;
    await Promise.all([killChild(shared), killChild(exclusive)]);
  }

  assert.equal(results.raceTrials, 20);
  assert.equal(results.wins.shared + results.wins.exclusive, 20);
  console.log(JSON.stringify({
    scope: 'single-host local temporary filesystem; current implementation copied with test-only pause hooks',
    results,
  }, null, 2));
} finally {
  await stopTrackedChildren(children, root);
  await rm(root, { recursive: true, force: true });
}
