import assert from 'node:assert/strict';
import test from 'node:test';
import {
  controlClockSnapshot,
  evaluateControlClock,
  SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS,
} from '../src/clock-skew.js';
import { startWorker } from '../src/worker-client.js';

test('control clock diagnostics correct for round trip and fail before the signature boundary', () => {
  const passed = evaluateControlClock(controlClockSnapshot(100_000), {
    requestStartedAt: 99_000,
    responseReceivedAt: 101_000,
  });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.offsetMs, 0);
  assert.equal(passed.uncertaintyMs, 1_000);
  assert.equal(passed.maxClockSkewMs, SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS);

  const warning = evaluateControlClock(controlClockSnapshot(220_000), {
    requestStartedAt: 99_000,
    responseReceivedAt: 101_000,
  });
  assert.equal(warning.status, 'warning');
  assert.equal(warning.offsetMs, 120_000);
  assert.match(warning.nextAction, /NTP\/Windows Time/);

  const failed = evaluateControlClock(controlClockSnapshot(390_000), {
    requestStartedAt: 99_000,
    responseReceivedAt: 101_000,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.worstCaseSkewMs, 291_000);
  assert.equal(failed.remainingWindowMs, 9_000);

  assert.equal(evaluateControlClock(null, {
    requestStartedAt: 99_000,
    responseReceivedAt: 101_000,
  }).status, 'unavailable');
});

test('Worker startup rejects unsafe control clock skew before registration', async () => {
  let registered = false;
  const client = {
    async health() {
      return {
        ok: true,
        clock: controlClockSnapshot(Date.now() + (10 * 60_000)),
      };
    },
    async registerWorker() {
      registered = true;
      throw new Error('registration should not run');
    },
  };
  await assert.rejects(
    () => startWorker({ id: 'clock-skew-worker', client, dataDir: '.nado-test-clock-skew' }),
    (error) => error.code === 'NADO_WORKER_CLOCK_SKEW' && error.clock?.status === 'failed',
  );
  assert.equal(registered, false);
});
