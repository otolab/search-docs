export const EMBEDDING_READY_TIMEOUT_ENV = 'SEARCH_DOCS_EMBEDDING_READY_TIMEOUT_MS';
export const DEFAULT_EMBEDDING_READY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve the shared embedding readiness window from an option or environment.
 * Values are milliseconds and must be positive safe integers.
 */
export function getEmbeddingReadyTimeoutMs(
  value?: string | number,
  envValue: string | null = process.env[EMBEDDING_READY_TIMEOUT_ENV] ?? null,
): number {
  const configuredValue = value ?? envValue ?? DEFAULT_EMBEDDING_READY_TIMEOUT_MS;
  const timeoutMs = Number(configuredValue);

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      `Invalid embedding readiness timeout: ${String(configuredValue)}. ` +
      `Use a positive integer in milliseconds with --ready-timeout or ${EMBEDDING_READY_TIMEOUT_ENV}.`,
    );
  }

  return timeoutMs;
}
