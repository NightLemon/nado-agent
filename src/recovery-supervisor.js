const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const MIN_AUTO_RECOVERY_OFFLINE_MS = 60_000;

export function normalizeAutoRecoveryOfflineMs(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(MIN_AUTO_RECOVERY_OFFLINE_MS, Math.floor(parsed));
}

export function startOfflineRecoverySupervisor(options = {}) {
  const store = options.store;
  const offlineAfterMs = normalizeAutoRecoveryOfflineMs(options.offlineAfterMs);
  const scanIntervalMs = Math.max(1_000, Number(options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS));
  let running = false;
  let stopped = false;
  let lastRunAt = null;
  let lastRecovered = 0;
  let lastExhausted = 0;
  let lastError = null;

  const run = async () => {
    if (!store || !offlineAfterMs || stopped || running) {
      return null;
    }
    running = true;
    try {
      const result = await store.recoverOfflineTasks({
        action: 'requeue',
        minOfflineMs: offlineAfterMs,
        includeExpiredLeases: true,
        sessionRecovery: 'same-worker',
        reason: `Automatically recovered after worker was offline for at least ${offlineAfterMs}ms`,
      });
      lastRunAt = new Date().toISOString();
      lastRecovered = result.recovered?.length || 0;
      lastExhausted = result.exhausted?.length || 0;
      lastError = null;
      options.onResult?.(result);
      return result;
    } catch (error) {
      lastRunAt = new Date().toISOString();
      lastError = error.message;
      options.onError?.(error);
      return null;
    } finally {
      running = false;
    }
  };

  const timer = offlineAfterMs ? setInterval(() => {
    void run();
  }, scanIntervalMs) : null;
  timer?.unref?.();

  return {
    enabled: Boolean(offlineAfterMs),
    offlineAfterMs,
    scanIntervalMs,
    run,
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
    },
    summary() {
      return {
        enabled: Boolean(offlineAfterMs),
        offlineAfterMs: offlineAfterMs || null,
        scanIntervalMs: offlineAfterMs ? scanIntervalMs : null,
        lastRunAt,
        lastRecovered,
        lastExhausted,
        lastError,
        deliverySemantics: 'at-least-once',
        taskLeaseMs: options.taskLeaseMs || null,
        taskLeases: true,
        boundedRetries: true,
        sessionTasksAutomaticRecovery: 'same-worker-only',
      };
    },
  };
}
