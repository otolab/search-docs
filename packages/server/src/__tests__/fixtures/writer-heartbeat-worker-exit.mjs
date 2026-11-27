export function isExpectedWorkerExit(outcome, duringShutdown) {
  if (!duringShutdown) return false;
  return (outcome.code === 0 && outcome.signal === null)
    || (outcome.code === null && outcome.signal === 'SIGTERM')
    || (outcome.code === 128 + 15 && outcome.signal === null);
}
