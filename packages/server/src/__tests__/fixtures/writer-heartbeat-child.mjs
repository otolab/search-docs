import { DBEngine } from '@search-docs/db-engine';
import { isExpectedWorkerExit } from './writer-heartbeat-worker-exit.mjs';

const WORKER_EXIT_TIMEOUT_MS = 5000;
let db;
let stopping = false;
const workerExits = new Map();

function hasExited(worker) {
  return worker.exitCode !== null || worker.signalCode !== null;
}

function exitStatus(worker) {
  return { code: worker.exitCode, signal: worker.signalCode };
}

function recordWorkerExit(worker, code, signal) {
  workerExits.set(worker, { code, signal, duringShutdown: stopping });
}

function observeWorker(worker) {
  worker.once('exit', (code, signal) => recordWorkerExit(worker, code, signal));
  if (hasExited(worker)) {
    recordWorkerExit(worker, worker.exitCode, worker.signalCode);
  }
}

function waitForWorkerExit(worker, timeoutMs) {
  if (hasExited(worker)) return Promise.resolve(exitStatus(worker));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('exit', onExit);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`DBEngine worker did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    worker.once('exit', onExit);
    if (hasExited(worker)) onExit(worker.exitCode, worker.signalCode);
  });
}

function signalWorkerGroup(worker, signal) {
  if (hasExited(worker) || !worker.pid) return;
  if (process.platform === 'win32') {
    if (!worker.kill(signal) && !hasExited(worker)) {
      throw new Error(`Could not send ${signal} to DBEngine worker ${worker.pid}`);
    }
    return;
  }
  try {
    process.kill(-worker.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopDatabase() {
  if (!db) return { workers: [] };
  const engine = db;
  const workers = [...engine.workerGroups];
  const errors = [];
  stopping = true;

  try {
    await engine.disconnect();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }

  const outcomes = [];
  for (const worker of workers) {
    let outcome;
    try {
      outcome = await waitForWorkerExit(worker, WORKER_EXIT_TIMEOUT_MS);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      try {
        signalWorkerGroup(worker, 'SIGKILL');
        outcome = await waitForWorkerExit(worker, WORKER_EXIT_TIMEOUT_MS);
      } catch (killError) {
        errors.push(killError instanceof Error ? killError : new Error(String(killError)));
      }
    }

    const observed = workerExits.get(worker);
    if (!outcome) continue;
    outcomes.push({ ...outcome, duringShutdown: observed?.duringShutdown ?? false });
    if (!observed?.duringShutdown) {
      errors.push(new Error(`DBEngine worker exited before shutdown: ${JSON.stringify(outcome)}`));
    }
    // The observed child is uv, which supervises the Python worker. The
    // process-structure regression test verifies that Python SIGABRT remains
    // 134 (also when triggered by SIGTERM), while intended group SIGTERM is 143.
    if (!isExpectedWorkerExit(outcome, observed?.duringShutdown ?? false)) {
      errors.push(new Error(`DBEngine worker stopped unexpectedly: ${JSON.stringify(outcome)}`));
    }
  }

  db = undefined;
  if (errors.length > 0) {
    throw new AggregateError(errors, 'DBEngine worker shutdown was not clean');
  }
  return { workers: outcomes };
}

process.on('message', async ({ id, command, args }) => {
  try {
    let value;
    if (command === 'connect') {
      db = new DBEngine({ dbPath: args.dbPath });
      await db.connect({ skipInitModel: true });
      const workers = [...db.workerGroups];
      if (workers.length === 0) throw new Error('DBEngine did not start a Python worker');
      for (const worker of workers) observeWorker(worker);
      value = { workerPids: workers.map(worker => worker.pid) };
    } else if (command === 'write-heartbeat') {
      if (!db) throw new Error('DBEngine is not connected');
      await db.claimWriter({ writerId: args.writerId, host: 'remote-test', pid: process.pid });
      await db.updateHeartbeat({
        writerId: args.writerId,
        host: 'remote-test',
        pid: process.pid,
        state: 'watching',
      });
      const result = await db.getWriterHeartbeat();
      if (!result.heartbeat) throw new Error('Writer heartbeat was not persisted');
      value = { timeZone: process.env.TZ, updatedAt: result.heartbeat.updatedAt };
    } else if (command === 'stop') {
      value = await stopDatabase();
      process.send?.({ id, value }, () => process.exit(0));
      setTimeout(() => process.exit(1), 1000).unref();
      return;
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    process.send?.({ id, value });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command === 'stop') {
      process.send?.({ id, error: message }, () => process.exit(1));
      setTimeout(() => process.exit(1), 1000).unref();
      return;
    }
    process.send?.({ id, error: message });
  }
});
