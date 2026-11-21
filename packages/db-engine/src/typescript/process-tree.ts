import type { ChildProcess } from 'node:child_process';

/** Windows の通常停止は直接の子プロセスを待つ。子孫全体の終了は保証しない。 */
export async function stopProcessTree(
  child: ChildProcess,
  timeoutMs = 5000,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        reject(new Error('子プロセスの終了を確認できません'));
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once('exit', onExit);
      try {
        if (!child.kill()) {
          child.off('exit', onExit);
          clearTimeout(timer);
          reject(new Error('子プロセスを停止できません'));
        }
      } catch (error) {
        child.off('exit', onExit);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return;
  }
  const pid = child.pid;
  if (!pid) throw new Error('プロセス ID がないため終了を確認できません');

  const exists = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };

  if (exists()) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (exists()) {
    if (Date.now() >= deadline) throw new Error(`プロセスグループ ${pid} の終了を確認できません`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
