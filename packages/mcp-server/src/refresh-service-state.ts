import { createService, detectSystemState, stopService, type ServiceInstances, type SystemStateInfo } from './state.js';
import type { SearchDocsService } from '@search-docs/types';

/** Stop the old service, reconstruct it, then report any shutdown failure to the caller. */
export async function refreshServiceState(options: {
  cwd: string;
  version: string;
  systemState: SystemStateInfo;
  getInstances: () => ServiceInstances | null;
  setInstances: (instances: ServiceInstances | null) => void;
  onRefreshed: () => void;
  debugLog: (message: string) => void;
  wrapService?: (service: SearchDocsService) => SearchDocsService;
}): Promise<void> {
  const { cwd, version, systemState, getInstances, setInstances, onRefreshed, debugLog } = options;
  let stopError: Error | undefined;
  const previous = getInstances();
  setInstances(null);
  systemState.service = undefined;
  if (previous) {
    try {
      await stopService(previous);
    } catch (error) {
      stopError = error instanceof Error ? error : new Error('Unknown shutdown failure');
    }
  }
  const newState = await detectSystemState(cwd);
  Object.assign(systemState, newState);
  if (systemState.state === 'RUNNING' && systemState.config) {
    try {
      const instances = await createService(systemState.config, systemState.projectRoot, version);
      setInstances(instances);
      systemState.service = options.wrapService?.(instances.service) ?? instances.service;
      debugLog('Service recreated after refresh');
    } catch (error) {
      if (stopError) throw new AggregateError([stopError, error], `Service shutdown and recreation failed: ${stopError instanceof Error ? stopError.message : 'unknown error'}; ${error instanceof Error ? error.message : 'unknown error'}`);
      throw error;
    }
  }
  onRefreshed();
  if (stopError) throw stopError;
}
