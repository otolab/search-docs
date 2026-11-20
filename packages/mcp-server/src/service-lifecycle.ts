import { stopService, type ServiceInstances } from './state.js';
import type { RequestGate } from './maintenance/request-gate.js';
import { MaintenanceNotStartedError } from './maintenance/exclusive-purge.js';

/** Serialize refresh and shutdown so every created service is eventually stopped. */
export class ServiceLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownRefreshError: Error | undefined;
  private maintenanceFailed = false;

  constructor(
    private readonly refreshService: () => Promise<void>,
    private readonly getInstances: () => ServiceInstances | null,
    private readonly setInstances: (instances: ServiceInstances | null) => void,
  ) {}

  refresh(): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Service is shutting down'));
    const operation = this.tail.then(async () => {
      if (this.shuttingDown) throw new Error('Service is shutting down');
      if (this.maintenanceFailed) throw new Error('保守処理が未完了のためサービスを再開できません');
      try {
        await this.refreshService();
      } catch (error) {
        if (this.shuttingDown) this.shutdownRefreshError = error instanceof Error ? error : new Error('Unknown refresh failure');
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  /** 未公開。operation は配置検証・排他・未完了マーカーを保持して実行する。 */
  maintenance(gate: RequestGate, deactivate: () => void, operation: () => Promise<void>): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Service is shutting down'));
    const task = this.tail.then(async () => {
      if (this.shuttingDown || this.maintenanceFailed) throw new Error('保守処理を開始できません');
      try {
        await gate.closeAndDrain();
        if (this.shuttingDown) return;
        deactivate();
        const instances = this.getInstances();
        if (instances) {
          await stopService(instances);
          this.setInstances(null);
        }
        if (this.shuttingDown) return;
        await operation();
        if (this.shuttingDown) return;
        await this.refreshService();
        gate.reopen();
      } catch (error) {
        if (error instanceof MaintenanceNotStartedError && !this.shuttingDown) {
          try {
            await this.refreshService();
            gate.reopen();
          } catch (restartError) {
            this.maintenanceFailed = true;
            throw new AggregateError([error, restartError], '削除前の失敗後にサービスを再開できません');
          }
          throw error;
        }
        this.maintenanceFailed = true;
        throw error;
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.tail.then(async () => {
      const instances = this.getInstances();
      this.setInstances(null);
      let stopError: Error | undefined;
      try {
        if (instances) await stopService(instances);
      } catch (error) {
        stopError = error instanceof Error ? error : new Error('Unknown shutdown failure');
      }
      if (this.shutdownRefreshError && stopError) {
        throw new AggregateError([this.shutdownRefreshError, stopError], 'Refresh and shutdown failed');
      }
      if (this.shutdownRefreshError) throw this.shutdownRefreshError;
      if (stopError) throw stopError;
    });
    return this.shutdownPromise;
  }
}

/** Install the same signal handlers used by the MCP process. */
export function registerShutdownHandlers(
  processEvents: Pick<NodeJS.Process, 'on'>,
  shutdown: () => Promise<void>,
  exit: (code: number) => void,
  reportError: (error: unknown) => void,
): void {
  let started = false;
  const handleSignal = () => {
    if (started) return;
    started = true;
    void shutdown().then(() => exit(0), (error: unknown) => { reportError(error); exit(1); });
  };
  processEvents.on('SIGINT', handleSignal);
  processEvents.on('SIGTERM', handleSignal);
}
