import { stopService, type ServiceInstances } from './state.js';

/** Serialize refresh and shutdown so every created service is eventually stopped. */
export class ServiceLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownRefreshError: Error | undefined;

  constructor(
    private readonly refreshService: () => Promise<void>,
    private readonly getInstances: () => ServiceInstances | null,
    private readonly setInstances: (instances: ServiceInstances | null) => void,
  ) {}

  refresh(): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Service is shutting down'));
    const operation = this.tail.then(async () => {
      if (this.shuttingDown) throw new Error('Service is shutting down');
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
