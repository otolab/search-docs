interface WorkerExitOutcome {
  code: number | null;
  signal: string | null;
}

export function isExpectedWorkerExit(
  outcome: WorkerExitOutcome,
  duringShutdown: boolean,
): boolean;
