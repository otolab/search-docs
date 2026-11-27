const closedChildren = new WeakSet();

export function trackChild(children, child) {
  children.add(child);
  child.on('error', () => {});
  child.once('close', () => {
    closedChildren.add(child);
    children.delete(child);
  });
  return child;
}

function waitForClose(child, timeoutMs) {
  if (closedChildren.has(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      reject(new Error(`child pid=${child.pid ?? 'unknown'} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('close', onClose);
  });
}

export async function stopTrackedChildren(children, resourcePath, timeoutMs = 5000) {
  const pending = [...children];
  const failures = [];
  await Promise.all(pending.map(async child => {
    if (closedChildren.has(child)) return;
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { child.kill('SIGKILL'); }
      catch (error) { failures.push(error); }
    }
    try { await waitForClose(child, timeoutMs); }
    catch (error) { failures.push(error); }
  }));

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Could not confirm all child processes stopped; preserving temporary data at ${resourcePath}`,
    );
  }
}

export async function stopProcessGroup(pid, timeoutMs = 5000) {
  if (!pid || process.platform === 'win32') return;
  const exists = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };

  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (exists()) {
    if (Date.now() >= deadline) {
      throw new Error(`Could not confirm process group ${pid} stopped`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
