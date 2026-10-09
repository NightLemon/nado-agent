export const SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const WORKER_CLOCK_WARNING_MS = 60_000;
export const WORKER_CLOCK_PREFLIGHT_SAFETY_MS = 30_000;

export function controlClockSnapshot(nowMs = Date.now()) {
  const unixMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return {
    serverTime: new Date(unixMs).toISOString(),
    serverUnixMs: unixMs,
    signedWorkerMaxSkewMs: SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS,
    recommendedMaxSkewMs: WORKER_CLOCK_WARNING_MS,
  };
}

export function evaluateControlClock(clock, options = {}) {
  const requestStartedAt = Number(options.requestStartedAt);
  const responseReceivedAt = Number(options.responseReceivedAt);
  const serverUnixMs = Number(clock?.serverUnixMs);
  const maxClockSkewMs = Number(clock?.signedWorkerMaxSkewMs);
  if (
    !Number.isFinite(requestStartedAt)
    || !Number.isFinite(responseReceivedAt)
    || responseReceivedAt < requestStartedAt
    || !Number.isFinite(serverUnixMs)
    || !Number.isFinite(maxClockSkewMs)
    || maxClockSkewMs <= 0
  ) {
    return {
      available: false,
      status: 'unavailable',
      reason: 'Control health does not expose a usable clock snapshot',
      nextAction: 'Upgrade the Control service to enable pre-signature clock diagnostics',
    };
  }
  const roundTripMs = responseReceivedAt - requestStartedAt;
  const localMidpointMs = requestStartedAt + (roundTripMs / 2);
  const offsetMs = Math.round(serverUnixMs - localMidpointMs);
  const uncertaintyMs = Math.ceil(roundTripMs / 2);
  const worstCaseSkewMs = Math.abs(offsetMs) + uncertaintyMs;
  const safetyMs = Math.max(0, Math.min(
    maxClockSkewMs,
    Number(options.safetyMs ?? WORKER_CLOCK_PREFLIGHT_SAFETY_MS),
  ));
  const warningMs = Math.max(0, Math.min(
    maxClockSkewMs - safetyMs,
    Number(clock?.recommendedMaxSkewMs ?? WORKER_CLOCK_WARNING_MS),
  ));
  const remainingWindowMs = maxClockSkewMs - worstCaseSkewMs;
  const status = worstCaseSkewMs > maxClockSkewMs - safetyMs
    ? 'failed'
    : worstCaseSkewMs > warningMs
      ? 'warning'
      : 'passed';
  return {
    available: true,
    status,
    serverTime: clock.serverTime || new Date(serverUnixMs).toISOString(),
    serverUnixMs,
    requestStartedAt,
    responseReceivedAt,
    localMidpointMs,
    roundTripMs,
    offsetMs,
    uncertaintyMs,
    worstCaseSkewMs,
    maxClockSkewMs,
    warningMs,
    safetyMs,
    remainingWindowMs,
    nextAction: status === 'passed'
      ? null
      : 'Synchronize both VM and Worker clocks with NTP/Windows Time, then rerun worker preflight before starting the service',
  };
}

export async function probeControlClock(client) {
  const requestStartedAt = Date.now();
  const health = await client.health();
  const responseReceivedAt = Date.now();
  return {
    health,
    clock: evaluateControlClock(health?.clock, { requestStartedAt, responseReceivedAt }),
  };
}
