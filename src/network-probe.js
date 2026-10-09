export const NETWORK_PROBE_MIN_BYTES = 4 * 1024;
export const NETWORK_PROBE_MAX_BYTES = 1024 * 1024;
export const NETWORK_PROBE_DEFAULT_BYTES = 64 * 1024;
export const NETWORK_PROBE_DEFAULT_INTERVAL_MS = 5 * 60_000;
export const NETWORK_PROBE_MIN_INTERVAL_MS = 60_000;

function rangeError(message, status = 400) {
  const error = new RangeError(message);
  error.status = status;
  return error;
}

export function normalizeNetworkProbeBytes(value = NETWORK_PROBE_DEFAULT_BYTES) {
  const bytes = Number(value ?? NETWORK_PROBE_DEFAULT_BYTES);
  if (!Number.isSafeInteger(bytes) || bytes < NETWORK_PROBE_MIN_BYTES) {
    throw rangeError(`Network probe bytes must be an integer of at least ${NETWORK_PROBE_MIN_BYTES}`);
  }
  if (bytes > NETWORK_PROBE_MAX_BYTES) {
    throw rangeError(`Network probe bytes cannot exceed ${NETWORK_PROBE_MAX_BYTES}`, 413);
  }
  return bytes;
}

export function normalizeNetworkProbeIntervalMs(value = NETWORK_PROBE_DEFAULT_INTERVAL_MS) {
  const intervalMs = Number(value ?? NETWORK_PROBE_DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    return 0;
  }
  if (!Number.isFinite(intervalMs) || intervalMs < NETWORK_PROBE_MIN_INTERVAL_MS) {
    throw rangeError(`Network probe interval must be 0 or at least ${NETWORK_PROBE_MIN_INTERVAL_MS}ms`);
  }
  return Math.floor(intervalMs);
}

export function bandwidthBytesPerSecond(bytes, durationMs) {
  const size = Math.max(0, Number(bytes || 0));
  const duration = Math.max(0.1, Number(durationMs || 0));
  return Math.round((size * 1000) / duration);
}

export async function measureControlBandwidth(client, workerId, options = {}) {
  const bytes = normalizeNetworkProbeBytes(options.bytes);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || 10_000));
  const download = await client.downloadWorkerNetworkProbe(workerId, bytes, { timeoutMs });
  const upload = await client.uploadWorkerNetworkProbe(workerId, bytes, { timeoutMs });
  return {
    available: true,
    probeBytes: bytes,
    downloadBytesPerSecond: bandwidthBytesPerSecond(bytes, download.durationMs),
    uploadBytesPerSecond: bandwidthBytesPerSecond(bytes, upload.durationMs),
    downloadDurationMs: download.durationMs,
    uploadDurationMs: upload.durationMs,
    sampledAt: new Date().toISOString(),
    measurement: 'bounded worker-initiated control transfer probe',
  };
}
